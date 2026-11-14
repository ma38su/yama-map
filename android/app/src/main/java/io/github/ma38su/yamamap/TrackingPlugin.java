package io.github.ma38su.yamamap;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.PowerManager;
import android.provider.Settings;

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
 * 位置情報の許可は Capacitor の checkPermissions / requestPermissions（別名 location）で求める
 */
@CapacitorPlugin(
    name = "Tracking",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION })
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
        Long startedAt = call.getLong("startedAt");
        try {
            TrackingService.start(getContext(), track, startedAt != null ? startedAt : System.currentTimeMillis());
            call.resolve();
        } catch (Exception e) {
            call.reject("記録を始められませんでした: " + e.getMessage(), "UNAVAILABLE", e);
        }
    }

    /** 記録をやめる。まとめて受け取る途中の測位も保存してから返す */
    @PluginMethod
    public void stop(PluginCall call) {
        TrackingService s = TrackingService.running;
        if (s == null) {
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
        call.resolve(ret);
    }

    @PluginMethod
    public void getFixes(PluginCall call) {
        String track = call.getString("trackId");
        if (track == null) {
            call.reject("trackId がありません");
            return;
        }
        long afterId = call.getLong("afterId", 0L);
        int limit = call.getInt("limit", 500);
        JSObject ret = new JSObject();
        ret.put("fixes", TrackingStore.get(getContext()).list(track, afterId, limit));
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
     * 電池の最適化から外す画面を開く（このアプリだけを聞くダイアログ）。開けなければ、アプリの一覧の設定画面。
     * Play ストアで配るときは、このダイアログを出すのは審査の対象になる（docs/android-plan.md）
     */
    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        String pkg = getContext().getPackageName();
        try {
            getActivity().startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + pkg)));
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
