package io.github.ma38su.yamamap;

import android.Manifest;
import android.app.ActivityManager;
import android.app.ApplicationExitInfo;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.hardware.Sensor;
import android.hardware.SensorManager;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.webkit.WebView;

import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.pm.PackageInfoCompat;
import androidx.core.location.LocationManagerCompat;

import java.io.BufferedReader;
import java.io.InputStreamReader;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

/**
 * 軌跡の記録（src/track/location.ts から使う）。記録そのものは TrackingService がする。
 * JS は start / stop で記録を始め・止め、getFixes でたまった測位を取り込む。
 * WebView が動いていれば（裏に回っていても）、測位を保存するたびに "fixes"、通知の「停止」で止めたら "stopped" を知らせる。
 * 位置情報の許可は Capacitor の checkPermissions / requestPermissions（別名 location）、歩数計の身体活動の許可は別名 activity で求める
 */
@CapacitorPlugin(
    name = "Tracking",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION }),
        // 歩数計（記録に歩数を残し、止まっているあいだは測位を間引く）。Android 10 から許可が要る
        @Permission(alias = "activity", strings = { Manifest.permission.ACTIVITY_RECOGNITION })
    }
)
public class TrackingPlugin extends Plugin {
    /** 読み込まれているプラグイン（WebView がなければ null）。TrackingService が JS に知らせるのに使う */
    private static volatile TrackingPlugin loaded;

    @Override
    public void load() {
        loaded = this;
    }

    @Override
    protected void handleOnDestroy() {
        if (loaded == this) loaded = null;
    }

    /** JS に知らせる（WebView がなければ何もしない。点は TrackingStore に残っているので、次に開いたときに取り込まれる） */
    static void signal(String event) {
        TrackingPlugin p = loaded;
        if (p != null) p.notifyListeners(event, new JSObject());
    }

    @PluginMethod
    public void start(PluginCall call) {
        String track = call.getString("trackId");
        if (track == null) {
            call.reject("trackId がありません");
            return;
        }
        if (getPermissionState("location") != PermissionState.GRANTED) {
            call.reject("位置情報が許可されていません", "NOT_AUTHORIZED");
            return;
        }
        // 数は JSON の数の大きさで Integer にも Long にもなる（PluginCall.getLong は Long しか読まない）ので、optLong で読む
        long startedAt = call.getData().optLong("startedAt", System.currentTimeMillis());
        try {
            TrackingService.start(getContext(), track, startedAt);
            call.resolve();
        } catch (Exception e) {
            call.reject("記録を始められませんでした: " + e.getMessage(), "UNAVAILABLE", e);
        }
    }

    /**
     * 記録をやめる。まとめて受け取る途中の測位も保存してから返す。
     * trackId を渡したら、その記録をしているときだけ止める（別の記録を始めたあとに、古い記録の止める依頼が届いても止めないように）
     */
    @PluginMethod
    public void stop(PluginCall call) {
        TrackingService s = TrackingService.running;
        String track = call.getString("trackId");
        if (s == null || (track != null && !track.equals(s.currentTrack()))) {
            call.resolve();
            return;
        }
        s.stopTracking(false, call::resolve);
    }

    /** 記録中か。recording が false で stoppedTrack があれば、その記録は通知の「停止」で止められた */
    @PluginMethod
    public void status(PluginCall call) {
        SharedPreferences p = TrackingService.prefs(getContext());
        String track = p.getString("track", null);
        JSObject ret = new JSObject();
        ret.put("recording", TrackingService.running != null && track != null);
        ret.put("trackId", track != null ? track : JSObject.NULL);
        String stopped = p.getString("stoppedTrack", null);
        ret.put("stoppedTrack", stopped != null ? stopped : JSObject.NULL);
        ret.put("stoppedAt", stopped != null ? p.getLong("stoppedAt", 0) : JSObject.NULL);
        // 今の気圧（記録中で、気圧計があれば）
        double hPa = TrackingService.latestHPa;
        ret.put("hPa", Double.isNaN(hPa) ? JSObject.NULL : hPa);
        ret.put("hPaAt", TrackingService.latestHPaAt);
        call.resolve(ret);
    }

    /** まだ取り込まれていない測位が残っている記録の id（記録を終えるときに取り込めなかった分を、次に開いたときに取り込む） */
    @PluginMethod
    public void pendingTracks(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("tracks", TrackingStore.get(getContext()).pendingTracks());
        call.resolve(ret);
    }

    @PluginMethod
    public void getFixes(PluginCall call) {
        String track = call.getString("trackId");
        if (track == null) {
            call.reject("trackId がありません");
            return;
        }
        // afterId は小さい数なので JSON では Integer になる。PluginCall.getLong だと読めずに 0 になり、毎回最初から返してしまう
        long afterId = call.getData().optLong("afterId", 0);
        // afterT（この時刻より後の測位だけ）は、記録を続けるときの最初の取り込み。取り込み済みの点を JS に渡さない
        long afterT = call.getData().optLong("afterT", Long.MIN_VALUE);
        int limit = call.getData().optInt("limit", 500);
        JSObject ret = new JSObject();
        ret.put("fixes", TrackingStore.get(getContext()).list(track, afterId, afterT, limit));
        call.resolve(ret);
    }

    /**
     * 電池の最適化の対象から外れているか。対象のままだと、画面を消して長く記録しているあいだに
     * Android の省電力機能で記録が止められることがある
     */
    @PluginMethod
    public void batteryOptimization(PluginCall call) {
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        JSObject ret = new JSObject();
        ret.put("ignoring", pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName()));
        call.resolve(ret);
    }

    /**
     * 電池の最適化の設定を開く。最適化の対象なら、外すか聞くダイアログ（このアプリだけ）。
     * もう外してあれば、このダイアログは何も出さずに閉じるので、アプリ情報の画面（「アプリの電池使用量」から変えられる）。
     * 開けなければ、アプリの一覧の設定画面。
     * Play ストアで配るときは、外すか聞くダイアログを出すのは審査の対象になる（docs/android-plan.md）
     */
    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        String pkg = getContext().getPackageName();
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        boolean ignoring = pm != null && pm.isIgnoringBatteryOptimizations(pkg);
        Intent first = ignoring
            ? new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + pkg))
            : new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + pkg));
        try {
            getActivity().startActivity(first);
        } catch (ActivityNotFoundException e) {
            try {
                getActivity().startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
            } catch (ActivityNotFoundException e2) {
                call.reject("設定画面を開けませんでした");
                return;
            }
        }
        call.resolve();
    }

    // ---------- 診断（メニューの「動作の記録」） ----------

    /** 端末とアプリの状態（USB でつながなくても、メニューから見て送れるように） */
    @PluginMethod
    public void diagnostics(PluginCall call) {
        Context ctx = getContext();
        JSObject ret = new JSObject();
        ret.put("device", Build.MANUFACTURER + " " + Build.MODEL);
        ret.put("android", Build.VERSION.RELEASE + "（API " + Build.VERSION.SDK_INT + "）");
        try {
            PackageInfo pi = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            long code = PackageInfoCompat.getLongVersionCode(pi);
            ret.put("app", pi.versionName + "（" + code + "）");
        } catch (Exception e) {
            ret.put("app", "不明");
        }
        PackageInfo wv = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O ? WebView.getCurrentWebViewPackage() : null;
        ret.put("webview", wv != null ? wv.packageName + " " + wv.versionName : "不明");
        ret.put("location", getPermissionState("location").toString());
        LocationManager lm = (LocationManager) ctx.getSystemService(Context.LOCATION_SERVICE);
        ret.put("locationEnabled", lm != null && LocationManagerCompat.isLocationEnabled(lm));
        ret.put("notifications", NotificationManagerCompat.from(ctx).areNotificationsEnabled());
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        ret.put("batteryOptimized", pm != null && !pm.isIgnoringBatteryOptimizations(ctx.getPackageName()));
        ret.put("powerSave", pm != null && pm.isPowerSaveMode());
        String track = TrackingService.prefs(ctx).getString("track", null);
        ret.put("serviceRunning", TrackingService.running != null);
        ret.put("serviceTrack", track != null ? track : JSObject.NULL);
        ret.put("pendingFixes", TrackingStore.get(ctx).pendingFixes());
        SensorManager sm = (SensorManager) ctx.getSystemService(Context.SENSOR_SERVICE);
        ret.put("stepCounter", sm != null && sm.getDefaultSensor(Sensor.TYPE_STEP_COUNTER) != null);
        ret.put("motionSensor", sm != null && sm.getDefaultSensor(Sensor.TYPE_SIGNIFICANT_MOTION) != null);
        ret.put("activity", Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || getPermissionState("activity") == PermissionState.GRANTED);
        ret.put("exits", recentExits(ctx));
        call.resolve(ret);
    }

    /**
     * アプリ（画面・記録のサービス）が最近終了した理由（新しい順に5回。Android 11 から）。
     * メモリ不足の知らせ（onTrimMemory）は Android 14 から届かなくなったので、止められたあとに理由を見る
     */
    private static JSArray recentExits(Context ctx) {
        JSArray out = new JSArray();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return out;
        ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
        if (am == null) return out;
        try {
            for (ApplicationExitInfo e : am.getHistoricalProcessExitReasons(ctx.getPackageName(), 0, 20)) {
                // WebView の描画用の別プロセス（isolated）の終了は除き、アプリ本体（画面と記録のサービス）だけ
                if (!ctx.getPackageName().equals(e.getProcessName())) continue;
                JSObject o = new JSObject();
                o.put("t", e.getTimestamp());
                o.put("reason", exitReason(e.getReason()));
                String desc = e.getDescription();
                o.put("description", desc != null ? desc : JSObject.NULL);
                o.put("importance", e.getImportance() <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND_SERVICE ? "表" : "裏");
                out.put(o);
                if (out.length() >= 5) break;
            }
        } catch (Exception e) {
            // 端末によっては読めない
        }
        return out;
    }

    /** 終了した理由（ApplicationExitInfo.REASON_*）を日本語に */
    private static String exitReason(int reason) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return String.valueOf(reason);
        switch (reason) {
            case ApplicationExitInfo.REASON_EXIT_SELF: return "自分で終了";
            case ApplicationExitInfo.REASON_SIGNALED: return "シグナルで終了";
            case ApplicationExitInfo.REASON_LOW_MEMORY: return "メモリ不足";
            case ApplicationExitInfo.REASON_CRASH: return "異常終了（Java）";
            case ApplicationExitInfo.REASON_CRASH_NATIVE: return "異常終了（ネイティブ）";
            case ApplicationExitInfo.REASON_ANR: return "応答なし（ANR）";
            case ApplicationExitInfo.REASON_INITIALIZATION_FAILURE: return "起動に失敗";
            case ApplicationExitInfo.REASON_PERMISSION_CHANGE: return "許可が変わった";
            case ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE: return "電池・CPU の使いすぎ";
            case ApplicationExitInfo.REASON_USER_REQUESTED: return "利用者が止めた（強制停止など）";
            case ApplicationExitInfo.REASON_USER_STOPPED: return "利用者が止めた（ユーザー切り替えなど）";
            case ApplicationExitInfo.REASON_DEPENDENCY_DIED: return "依存先が終了";
            case ApplicationExitInfo.REASON_OTHER: return "その他（システムによる終了）";
            case ApplicationExitInfo.REASON_FREEZER: return "凍結中に終了";
            case ApplicationExitInfo.REASON_PACKAGE_STATE_CHANGE: return "アプリの状態が変わった";
            case ApplicationExitInfo.REASON_PACKAGE_UPDATED: return "アプリを更新した";
            default: return "不明（" + reason + "）";
        }
    }

    /** 記録のサービスのログ（新しい順に limit 行） */
    @PluginMethod
    public void getLog(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("lines", TrackingStore.get(getContext()).logLines(call.getInt("limit", 300)));
        call.resolve(ret);
    }

    @PluginMethod
    public void clearLog(PluginCall call) {
        TrackingStore.get(getContext()).clearLog();
        call.resolve();
    }

    /**
     * このアプリの logcat（最新 lines 行）。アプリは自分の出したログだけ読める（落ちたときの記録も含む）。
     * 端末に残っている分だけなので、古いものは消えている
     */
    @PluginMethod
    public void getLogcat(PluginCall call) {
        int lines = call.getInt("lines", 300);
        StringBuilder sb = new StringBuilder();
        try {
            Process proc = new ProcessBuilder("logcat", "-d", "-v", "time", "-t", String.valueOf(lines)).redirectErrorStream(true).start();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(proc.getInputStream()))) {
                String line;
                while ((line = r.readLine()) != null) sb.append(line).append('\n');
            }
            proc.waitFor();
        } catch (Exception e) {
            sb.append("logcat を読めませんでした: ").append(e);
        }
        JSObject ret = new JSObject();
        ret.put("text", sb.toString());
        call.resolve(ret);
    }

    /** 取り込み終えた記録の測位を消す（通知の「停止」の印も消す） */
    @PluginMethod
    public void clearFixes(PluginCall call) {
        String track = call.getString("trackId");
        if (track == null) {
            call.reject("trackId がありません");
            return;
        }
        TrackingStore.get(getContext()).clear(track);
        SharedPreferences p = TrackingService.prefs(getContext());
        if (track.equals(p.getString("stoppedTrack", null))) p.edit().remove("stoppedTrack").remove("stoppedAt").apply();
        call.resolve();
    }
}
