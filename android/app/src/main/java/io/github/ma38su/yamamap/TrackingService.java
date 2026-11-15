package io.github.ma38su.yamamap;

import android.Manifest;
import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.hardware.TriggerEvent;
import android.hardware.TriggerEventListener;
import android.location.Location;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationAvailability;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/**
 * 軌跡の記録（フォアグラウンドサービス）。届いた測位はその場で TrackingStore に保存し、WebView が動いていれば JS に知らせる。
 * アプリの画面（Activity）や WebView とは結び付けていないので、履歴からスワイプして消しても、
 * WebView が止められても記録は続く。止めるのはアプリの「記録終了」か、通知の「停止」だけ。
 *  - 測位は1秒間隔・5m 動いたときだけ。最大20秒ぶんまとめて受け取る（その間 CPU を眠らせておける）
 *  - 気圧計があれば、気圧も点と一緒に残す（JS の気圧高度計で標高を補う）。今の気圧は TrackingPlugin の status からも読める
 *  - 歩数計があり、身体活動の許可があれば、記録を始めてからの歩数も点と一緒に残す。
 *    3分間歩数が増えず、GPS でも30m以上動いていなければ（休憩・山小屋）、止まっているとみなして GPS を止め、
 *    低電力の測位（5分おき）にする。大きな動きを感じた（significant motion）・歩数が増えた・遠くの測位が届いたら、すぐ元に戻す
 *    （車やバスでは歩数が増えなくても GPS の位置が動くので、間引かない）
 *  - システムに止められて再起動されたら（START_STICKY）、記録中だった記録を続ける
 *  - あとでパフォーマンスを分析できるよう、10分ごとに「計測」の1行をログに残す（電池・温度・測位の届き具合・画面が点いていた時間など）。
 *    handler の時間は端末が眠っているあいだ進まないので（測位を間引いているときなど）、アラームでも起こしてもらう
 * スレッド：onStartCommand と止める依頼はメインスレッドなどから来るが、測位・気圧・画面のオン/オフ・計測の値は
 * すべて記録用のスレッド（handler）で扱う。track だけはどこからでも読むので volatile にしている
 */
public class TrackingService extends Service implements SensorEventListener {
    static final String ACTION_START = "io.github.ma38su.yamamap.TRACKING_START";
    static final String ACTION_STOP = "io.github.ma38su.yamamap.TRACKING_STOP";
    static final String EXTRA_TRACK = "track";
    static final String EXTRA_STARTED_AT = "startedAt";

    private static final String TAG = "YamaTracking";
    private static final String CHANNEL = "tracking";
    private static final int NOTIFICATION_ID = 1;
    /** 記録が止まったことを知らせる通知（音とバイブは端末の設定どおり） */
    private static final String ALERT_CHANNEL = "tracking-alert";
    private static final int ALERT_ID = 2;
    /** 測位の届き具合をログにまとめて書く間隔 */
    private static final long SUMMARY_MS = 10 * 60_000;
    /** 端末が眠っていても計測を書くためのアラーム（このサービスが受け取る） */
    private static final String ACTION_SUMMARY = "io.github.ma38su.yamamap.TRACKING_SUMMARY";
    private static final long INTERVAL_MS = 1000;
    private static final float MIN_DISTANCE_M = 5;
    private static final long MAX_DELAY_MS = 20_000;
    /** 通知の距離に数える測位（JS の記録と同じく、誤差40m以内・8m以上動いたとき） */
    private static final float COUNT_ACCURACY_M = 40;
    private static final float COUNT_STEP_M = 8;
    /** これより古い気圧は点に付けない */
    private static final long PRESSURE_STALE_MS = 2 * 60_000;
    /** 歩数が増えず、GPS でも動いていない時間がこれだけ続いたら、止まっているとみなして測位を間引く */
    private static final long STILL_AFTER_MS = 3 * 60_000;
    /** 止まっているかを確かめる間隔 */
    private static final long STILL_CHECK_MS = 30_000;
    /** この半径の中なら、GPS では動いていないとみなす（測位のぶれを含めて） */
    private static final float STILL_RADIUS_M = 30;
    /** 止まっているあいだの測位（低電力。Wi-Fi・基地局など）の間隔と、届けてもらう距離 */
    private static final long STILL_INTERVAL_MS = 5 * 60_000;
    private static final float STILL_DISTANCE_M = 50;
    /** 止まっているあいだに、これだけ歩いたら（歩数が増えたら）測位を戻す */
    private static final long RESUME_STEPS = 10;
    /** 止まっているあいだに、これだけ離れた測位が届いたら（歩数計に出ない乗り物など）測位を戻す */
    private static final float RESUME_DISTANCE_M = 100;
    /** 測位が使えない状態がこれだけ続いたら、ログに書く（短く途切れるのは10分ごとの計測に回数だけ書く） */
    private static final long UNAVAILABLE_LOG_MS = 60_000;

    /** 動いているサービス（なければ null）。TrackingPlugin が止めるときに使う */
    static volatile TrackingService running;
    /** 今の気圧 (hPa) とその時刻。記録中だけ（TrackingPlugin の status で JS に渡す） */
    static volatile double latestHPa = Double.NaN;
    static volatile long latestHPaAt;

    private FusedLocationProviderClient fused;
    private HandlerThread thread;
    private Handler handler;
    /** 記録中の記録（どのスレッドからも読む） */
    private volatile String track;
    private volatile long startedAt;
    /** 記録を始めた回数。止めているあいだに次の記録が始まったら、止める処理で新しい記録を消さないように */
    private int generation;

    // ---------- 止める依頼（synchronized (this) で扱う） ----------
    private boolean stopping;
    private final List<Runnable> stopWaiters = new ArrayList<>();

    // ---------- ここから下は記録用のスレッド（handler）だけで扱う ----------
    private double distance;
    private Location counted;
    private long notifiedAt;
    private SensorManager sensors;
    private double hPa = Double.NaN;
    private long hPaAt;
    private Boolean available;
    /** 届いた測位の数と、受け取った回数（まとめて届くので、回数のほうが少ない） */
    private int received;
    private int deliveries;
    private final List<Float> accuracies = new ArrayList<>();
    private long summarizedAt;
    /** 画面が点いていた時間 (ms)。点いているあいだは screenOnSince に点いた時刻 */
    private long screenOnMs;
    private long screenOnSince;
    private final Runnable summaryTask = this::summarize;
    /** 前の計測のときの電池の残り (mAh。測れなければ -1)。10分ごとの減りを出す */
    private int summarizedMah = -1;
    private final BroadcastReceiver summaryReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            // 端末が起きていれば handler がもう書いている（そのあとに届いた古いアラームは捨てる）
            if (track != null && SystemClock.elapsedRealtime() - summarizedAt >= SUMMARY_MS / 2) summarize();
        }
    };
    /** 測位が使えない状態になった回数（10分ごとの計測に書く）と、使えなくなった時刻（ログに書いたら記録しておく） */
    private int unavailableCount;
    private long unavailableSince;
    private boolean unavailableLogged;
    private final Runnable unavailableTask = () -> {
        if (track == null || available == null || available) return;
        unavailableLogged = true;
        TrackingStore.log(TrackingService.this, "測位が1分以上使えない（GPS の電波が届かない・位置情報がオフなど）");
    };

    // ---------- 歩数と、止まっているあいだの測位の間引き（記録用のスレッド） ----------
    /** 歩数計（なければ・身体活動の許可がなければ null。そのときは歩数を残さず、測位も間引かない） */
    private Sensor stepSensor;
    /** 大きな動きを感じたら一度だけ知らせるセンサー（止まっているあいだに、歩き出した・乗り物で動き出したのを知る） */
    private Sensor motionSensor;
    /** 記録を始めてからの歩数（-1 は歩数計なし）。歩数計の値（端末を起動してからの歩数）との対応は stepCounterBase・stepsBase */
    private long steps = -1;
    private long stepCounterBase = -1;
    private long stepsBase;
    /** 最後に歩数が増えた時刻・GPS で STILL_RADIUS_M 以上動いた時刻（elapsedRealtime）と、そのときの位置 */
    private long steppedAt;
    private long movedAt;
    private Location anchor;
    /** 止まっているとみなして測位を間引いているか。間引き始めた時刻と歩数、10分ごとの計測に書く間引いた時間 */
    private boolean still;
    private long stillSince;
    private long stepsAtStill;
    private long stillMs;
    private final Runnable stillTask = this::checkStill;
    private final TriggerEventListener motionListener = new TriggerEventListener() {
        @Override
        public void onTrigger(TriggerEvent event) {
            // メインスレッドで届くので、記録用のスレッドで扱う
            handler.post(() -> setStill(false, "大きな動きを感じた"));
        }
    };
    private final BroadcastReceiver screenReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            boolean on = Intent.ACTION_SCREEN_ON.equals(intent.getAction());
            long now = SystemClock.elapsedRealtime();
            if (on && screenOnSince == 0) screenOnSince = now;
            else if (!on && screenOnSince != 0) {
                screenOnMs += now - screenOnSince;
                screenOnSince = 0;
            }
            if (track != null) TrackingStore.log(TrackingService.this, on ? "画面オン" : "画面オフ");
        }
    };

    private final LocationCallback callback = new LocationCallback() {
        @Override
        public void onLocationResult(@NonNull LocationResult result) {
            String t = track;
            if (t == null) return;
            List<Location> locations = result.getLocations();
            // 最大 MAX_DELAY_MS ぶんまとめて届くので、気圧と歩数は点ごとに、その点の時刻の値を付ける（届いたときの値をまとめて付けない）
            int n = locations.size();
            Double[] pressures = new Double[n];
            Long[] stepCounts = new Long[n];
            for (int i = 0; i < n; i++) {
                long at = locations.get(i).getElapsedRealtimeNanos() / 1_000_000;
                pressures[i] = pressureAt(at);
                stepCounts[i] = stepsAt(at);
            }
            // 1回に届いた分は、まとめて1回で保存する
            TrackingStore.get(TrackingService.this).addAll(t, locations, pressures, stepCounts);
            deliveries++;
            for (Location loc : locations) {
                received++;
                if (!loc.hasAccuracy()) continue;
                accuracies.add(loc.getAccuracy());
                if (loc.getAccuracy() > COUNT_ACCURACY_M) continue;
                trackMovement(loc);
                if (counted == null) counted = loc;
                else if (loc.distanceTo(counted) >= COUNT_STEP_M) {
                    distance += loc.distanceTo(counted);
                    counted = loc;
                }
            }
            TrackingPlugin.signal("fixes");
            // 距離の表示は1分に1回まで書き換える（経過時間は通知が自分で進める）
            if (SystemClock.elapsedRealtime() - notifiedAt > 60_000) notifyProgress();
        }

        @Override
        public void onLocationAvailability(@NonNull LocationAvailability availability) {
            // 測位が使えなくなった・戻った（GPS の電波が届かない、位置情報がオフにされた、など）。
            // 谷などでは数十秒ごとに行ったり来たりするので、回数だけ数え、1分以上続いたときだけログに書く
            boolean now = availability.isLocationAvailable();
            if (available != null && available == now) return;
            available = now;
            if (track == null) return;
            if (!now) {
                unavailableCount++;
                unavailableSince = SystemClock.elapsedRealtime();
                handler.removeCallbacks(unavailableTask);
                handler.postDelayed(unavailableTask, UNAVAILABLE_LOG_MS);
            } else {
                handler.removeCallbacks(unavailableTask);
                if (unavailableLogged) {
                    TrackingStore.log(TrackingService.this, String.format(Locale.JAPAN, "測位が使える状態に戻った（%.0f分ぶり）", (SystemClock.elapsedRealtime() - unavailableSince) / 60_000.0));
                }
                unavailableLogged = false;
            }
        }
    };

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences("tracking", Context.MODE_PRIVATE);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        fused = LocationServices.getFusedLocationProviderClient(this);
        thread = new HandlerThread("tracking");
        thread.start();
        handler = new Handler(thread.getLooper());
        sensors = (SensorManager) getSystemService(Context.SENSOR_SERVICE);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action)) {
            // 通知の「停止」。JS は次に表に出たときに status() で知って、記録を締める
            TrackingStore.log(this, "通知の「停止」で記録を止めた");
            stopTracking(true, null);
            return START_NOT_STICKY;
        }
        SharedPreferences p = prefs(this);
        String id = intent != null ? intent.getStringExtra(EXTRA_TRACK) : null;
        long since = intent != null ? intent.getLongExtra(EXTRA_STARTED_AT, System.currentTimeMillis()) : 0;
        boolean restarted = id == null;
        if (restarted) {
            // システムに止められたあとの再起動（intent なし）。記録中だった記録があれば続ける
            id = p.getString("track", null);
            since = p.getLong("startedAt", System.currentTimeMillis());
            if (id == null) {
                TrackingStore.log(this, "記録のサービスが再起動したが、記録中の記録がないので終える");
                stopSelf();
                return START_NOT_STICKY;
            }
        }
        if (id.equals(track)) return START_STICKY; // もう記録している
        // 世代は、この記録の値を書く前に進める（前の記録を止める処理がちょうど走っていても、世代が変わっていれば、この記録の値を消さない）
        synchronized (this) {
            generation++;
        }
        boolean resumed = id.equals(p.getString("track", null));
        TrackingStore.log(this, restarted
            ? "システムに止められたあと、記録のサービスが再起動した（記録 " + shortId(id) + " を続ける）"
            : "記録のサービスを開始（記録 " + shortId(id) + "・" + (resumed ? "続き" : "新規") + "）");
        track = id;
        startedAt = since;
        p.edit()
            .putString("track", id)
            .putLong("startedAt", since)
            .remove("stoppedTrack")
            .remove("stoppedAt")
            .apply();
        try {
            int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION : 0;
            ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(0), type);
        } catch (Exception e) {
            // 位置情報の許可がない・裏からは始められない（Android 12 以降）など
            Log.e(TAG, "フォアグラウンドサービスを始められませんでした", e);
            TrackingStore.log(this, "記録のサービスを始められなかった: " + e);
            track = null;
            // 再起動で始められなかったら、記録が止まったことを知らせる（タップして開けば、続きを記録するか聞かれる）
            if (restarted) notifyStopped();
            stopSelf();
            return START_NOT_STICKY;
        }
        running = this;
        // 記録の値の準備と測位の開始は、記録用のスレッドで
        final boolean fresh = !resumed;
        final String startTrack = id;
        handler.post(() -> {
            // 続きなら、ここまでの距離を残っている測位から数え直して、通知に出す
            distance = fresh ? 0 : TrackingStore.get(this).distance(startTrack, COUNT_ACCURACY_M, COUNT_STEP_M);
            counted = null;
            if (!fresh) notifyProgress();
            available = null;
            startMeasuring(fresh);
            startSteps(fresh);
            requestUpdates();
            startPressure();
        });
        return START_STICKY;
    }

    /** 測位を頼む（同じ callback で頼み直すと置き換わる）。止まっているあいだは低電力の測位 */
    private void requestUpdates() {
        LocationRequest request = still
            ? new LocationRequest.Builder(Priority.PRIORITY_BALANCED_POWER_ACCURACY, STILL_INTERVAL_MS)
                .setMinUpdateDistanceMeters(STILL_DISTANCE_M)
                .build()
            : new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, INTERVAL_MS)
                .setMinUpdateDistanceMeters(MIN_DISTANCE_M)
                .setMaxUpdateDelayMillis(MAX_DELAY_MS)
                .build();
        try {
            fused.requestLocationUpdates(request, callback, thread.getLooper()).addOnFailureListener(e -> {
                // Google Play 開発者サービスがない・許可が足りない（裏から再起動したときなど）
                TrackingStore.log(this, "測位を始められなかったので記録を止めた: " + e);
                notifyStopped();
                stopTracking(false, null);
            });
        } catch (SecurityException e) {
            Log.e(TAG, "位置情報の許可がありません", e);
            TrackingStore.log(this, "位置情報の許可がないので記録を止めた: " + e.getMessage());
            notifyStopped();
            stopTracking(false, null);
        }
    }

    // ---------- 計測（記録用のスレッド） ----------

    /** 計測を始める。新しい記録なら、記録全体の電池の減りを出すために、始めの電池残量を残す */
    private void startMeasuring(boolean fresh) {
        summarizedAt = SystemClock.elapsedRealtime();
        received = 0;
        deliveries = 0;
        accuracies.clear();
        screenOnMs = 0;
        unavailableCount = 0;
        stillMs = 0;
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        screenOnSince = pm != null && pm.isInteractive() ? summarizedAt : 0;
        summarizedMah = batteryMah();
        IntentFilter f = new IntentFilter(Intent.ACTION_SCREEN_ON);
        f.addAction(Intent.ACTION_SCREEN_OFF);
        unregister(screenReceiver);
        unregister(summaryReceiver);
        // 画面のオン/オフと計測のアラームも記録用のスレッドで受け取る
        ContextCompat.registerReceiver(this, screenReceiver, f, null, handler, ContextCompat.RECEIVER_NOT_EXPORTED);
        ContextCompat.registerReceiver(this, summaryReceiver, new IntentFilter(ACTION_SUMMARY), null, handler, ContextCompat.RECEIVER_NOT_EXPORTED);
        SharedPreferences p = prefs(this);
        if (fresh || !p.contains("startBattery")) {
            p.edit()
                .putInt("startBattery", batteryPercent())
                .putInt("startMah", summarizedMah)
                .putLong("startBatteryAt", System.currentTimeMillis())
                .apply();
        }
        scheduleSummary();
        TrackingStore.log(this, "計測 開始 " + deviceState());
    }

    /**
     * 次の計測を頼む。handler の時間（uptimeMillis）は端末が眠っているあいだ進まないので、
     * 眠っていても起こしてもらえるアラームも掛けておく（Android 12 からは数分遅れることがある。区間は実際の時間で書く）。
     * 起きていれば handler が先に書いて、アラームを掛け直す
     */
    private void scheduleSummary() {
        handler.removeCallbacks(summaryTask);
        handler.postDelayed(summaryTask, SUMMARY_MS);
        AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
        if (am != null) am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, summarizedAt + SUMMARY_MS, summaryAlarm());
    }

    private PendingIntent summaryAlarm() {
        return PendingIntent.getBroadcast(
            this,
            3,
            new Intent(ACTION_SUMMARY).setPackage(getPackageName()),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
    }

    private void unregister(BroadcastReceiver receiver) {
        try {
            unregisterReceiver(receiver);
        } catch (IllegalArgumentException ignored) {
            // 登録していない
        }
    }

    /** 10分ごとの計測の1行。あとで分析しやすいよう「名前=値」を空白で区切る */
    private void summarize() {
        if (track == null) return;
        long now = SystemClock.elapsedRealtime();
        long screen = screenOnMs + (screenOnSince != 0 ? now - screenOnSince : 0);
        if (screenOnSince != 0) screenOnSince = now;
        screenOnMs = 0;
        String acc = "-";
        if (!accuracies.isEmpty()) {
            Collections.sort(accuracies);
            acc = String.format(Locale.JAPAN, "%.0f/%.0fm", accuracies.get(accuracies.size() / 2), accuracies.get(accuracies.size() - 1));
        }
        long stillNow = stillMs + (still ? now - stillSince : 0);
        if (still) stillSince = now;
        int mah = batteryMah();
        TrackingStore.log(this, String.format(Locale.JAPAN,
            "計測 区間=%d分 測位=%d件 受信=%d回 精度(中央/最大)=%s 測位なし=%d回 画面オン=%.1f分 距離=%.0fm 歩数=%s 間引き=%.1f分 気圧=%s 消費=%s %s",
            Math.round((now - summarizedAt) / 60_000.0), received, deliveries, acc, unavailableCount, screen / 60_000.0, distance,
            steps >= 0 ? String.valueOf(steps) : "なし", stillNow / 60_000.0,
            !Double.isNaN(hPa) ? String.format(Locale.JAPAN, "%.1fhPa", hPa) : "なし", usage(summarizedMah, mah, now - summarizedAt), deviceState()));
        summarizedAt = now;
        summarizedMah = mah;
        received = 0;
        deliveries = 0;
        accuracies.clear();
        unavailableCount = 0;
        stillMs = 0;
        // 端末が再起動して記録のサービスも始め直したときに、歩数を続きから数えられるように
        if (steps >= 0) prefs(this).edit().putLong("steps", steps).apply();
        scheduleSummary();
    }

    /** 電池残量（% と mAh）・温度・充電・発熱・省電力モード */
    private String deviceState() {
        Intent b = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        float temp = b != null ? b.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) / 10f : Float.NaN;
        boolean plugged = b != null && b.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0;
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        String thermal = pm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? String.valueOf(pm.getCurrentThermalStatus()) : "-";
        int mah = batteryMah();
        return String.format(Locale.JAPAN, "電池=%d%% 残量=%s 温度=%.1f℃ 充電=%s 発熱=%s 省電力=%s",
            batteryPercent(), mah >= 0 ? mah + "mAh" : "なし", temp, plugged ? "中" : "なし", thermal, pm != null && pm.isPowerSaveMode() ? "オン" : "オフ");
    }

    private int batteryPercent() {
        BatteryManager bm = (BatteryManager) getSystemService(Context.BATTERY_SERVICE);
        return bm != null ? bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) : -1;
    }

    /** 電池の残り (mAh。電池の残量計の値。測れない端末は -1)。% より細かいので、短い時間の減りも比べられる */
    private int batteryMah() {
        BatteryManager bm = (BatteryManager) getSystemService(Context.BATTERY_SERVICE);
        // µAh。測れない端末は Integer.MIN_VALUE か 0
        int uah = bm != null ? bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER) : 0;
        return uah > 0 ? uah / 1000 : -1;
    }

    /** 電池の減り (mAh) と1時間あたり。1時間あたりは1分以上のときだけ（短いと大きくぶれる） */
    private static String usage(int fromMah, int toMah, long ms) {
        if (fromMah < 0 || toMah < 0) return "なし";
        int used = fromMah - toMah;
        return ms >= 60_000
            ? String.format(Locale.JAPAN, "%dmAh(1時間あたり%.0fmAh)", used, used * 3_600_000.0 / ms)
            : used + "mAh";
    }

    /** 記録全体の電池の減り（記録を終えたとき） */
    private void logBatteryUsage() {
        SharedPreferences p = prefs(this);
        int start = p.getInt("startBattery", -1);
        int startMah = p.getInt("startMah", -1);
        long at = p.getLong("startBatteryAt", 0);
        int end = batteryPercent();
        int endMah = batteryMah();
        long ms = System.currentTimeMillis() - at;
        double hours = ms / 3_600_000.0;
        if (start < 0 || end < 0 || hours <= 0) return;
        TrackingStore.log(this, String.format(Locale.JAPAN,
            "計測 記録全体 電池=%d%%→%d%% 残量=%s 時間=%.1f時間 1時間あたり=%.1f%% 消費=%s 距離=%.0fm（途中で充電していれば正しくない）",
            start, end, startMah >= 0 && endMah >= 0 ? startMah + "→" + endMah + "mAh" : "なし", hours, (start - end) / hours,
            usage(startMah, endMah, ms), distance));
    }

    private void stopMeasuring() {
        handler.removeCallbacks(summaryTask);
        handler.removeCallbacks(unavailableTask);
        handler.removeCallbacks(stillTask);
        cancelSummaryAlarm();
        if (motionSensor != null) sensors.cancelTriggerSensor(motionListener, motionSensor);
        still = false;
        unregister(screenReceiver);
        unregister(summaryReceiver);
    }

    private void cancelSummaryAlarm() {
        AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
        if (am != null) am.cancel(summaryAlarm());
    }

    private void startPressure() {
        Sensor sensor = sensors != null ? sensors.getDefaultSensor(Sensor.TYPE_PRESSURE) : null;
        // 気圧はゆっくりしか変わらないので、1秒に1回・最大10秒まとめて届けてもらう
        if (sensor != null) sensors.registerListener(this, sensor, 1_000_000, 10_000_000, handler);
    }

    // ---------- 歩数と、止まっているあいだの間引き ----------

    /** 身体活動の許可（Android 10 から。歩数計に要る） */
    private boolean activityAllowed() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
            || ContextCompat.checkSelfPermission(this, Manifest.permission.ACTIVITY_RECOGNITION) == PackageManager.PERMISSION_GRANTED;
    }

    /** 歩数計を使い始める（なければ・許可がなければ、歩数は残さず測位も間引かない） */
    private void startSteps(boolean fresh) {
        Sensor sensor = sensors != null && activityAllowed() ? sensors.getDefaultSensor(Sensor.TYPE_STEP_COUNTER) : null;
        stepSensor = sensor;
        motionSensor = sensors != null ? sensors.getDefaultSensor(Sensor.TYPE_SIGNIFICANT_MOTION) : null;
        still = false;
        long now = SystemClock.elapsedRealtime();
        steppedAt = now;
        movedAt = now;
        anchor = null;
        if (sensor == null) {
            steps = -1;
            TrackingStore.log(this, "歩数計: " + (sensors != null && sensors.getDefaultSensor(Sensor.TYPE_STEP_COUNTER) != null ? "身体活動の許可がないので使わない" : "なし") + "（測位は間引かない）");
            return;
        }
        SharedPreferences p = prefs(this);
        if (fresh) {
            p.edit().remove("stepCounterBase").remove("stepsBase").remove("steps").apply();
            steps = 0;
            stepCounterBase = -1;
            stepsBase = 0;
        } else {
            // 続き：前に残した歩数から
            steps = p.getLong("steps", 0);
            stepCounterBase = p.getLong("stepCounterBase", -1);
            stepsBase = p.getLong("stepsBase", 0);
        }
        // 歩数はゆっくりでよいので、最大10秒まとめて届けてもらう
        sensors.registerListener(this, sensor, SensorManager.SENSOR_DELAY_NORMAL, 10_000_000, handler);
        handler.removeCallbacks(stillTask);
        handler.postDelayed(stillTask, STILL_CHECK_MS);
        TrackingStore.log(this, "歩数計: あり（止まっているあいだは測位を間引く" + (motionSensor != null ? "" : "。動きのセンサーがないので、戻るのは歩数か測位で") + "）");
    }

    /** 歩数計の値（端末を起動してからの歩数）から、記録を始めてからの歩数にする */
    private void onSteps(long counter) {
        if (stepCounterBase < 0 || counter < stepCounterBase) {
            // 始めて読んだ・端末が再起動して歩数計が数え直された：ここからの増えた分を、今の歩数に足していく
            stepsBase = Math.max(0, steps);
            stepCounterBase = counter;
            prefs(this).edit().putLong("stepCounterBase", stepCounterBase).putLong("stepsBase", stepsBase).apply();
        }
        long now = stepsBase + (counter - stepCounterBase);
        if (now > steps) {
            steppedAt = SystemClock.elapsedRealtime();
            if (still && now - stepsAtStill >= RESUME_STEPS) {
                steps = now;
                setStill(false, "歩き出した");
            }
        }
        steps = Math.max(steps, now);
    }

    /** GPS で STILL_RADIUS_M 以上動いたか（止まっているあいだは、遠くの測位で戻す） */
    private void trackMovement(Location loc) {
        if (anchor == null) {
            anchor = loc;
            movedAt = SystemClock.elapsedRealtime();
            return;
        }
        float d = loc.distanceTo(anchor);
        if (d < STILL_RADIUS_M) return;
        anchor = loc;
        movedAt = SystemClock.elapsedRealtime();
        if (still && d >= RESUME_DISTANCE_M) setStill(false, "離れた所の測位が届いた");
    }

    /** 歩数が増えず、GPS でも動いていない時間が続いたら、止まっているとみなす */
    private void checkStill() {
        if (track == null || stepSensor == null) return;
        long now = SystemClock.elapsedRealtime();
        if (!still && now - steppedAt >= STILL_AFTER_MS && now - movedAt >= STILL_AFTER_MS) setStill(true, null);
        handler.removeCallbacks(stillTask);
        handler.postDelayed(stillTask, STILL_CHECK_MS);
    }

    /** 止まっている（測位を間引く）・動き出した（もとの測位に戻す）を切り替える */
    private void setStill(boolean on, String why) {
        if (still == on || track == null) return;
        long now = SystemClock.elapsedRealtime();
        still = on;
        if (on) {
            stillSince = now;
            stepsAtStill = steps;
            if (motionSensor != null) sensors.requestTriggerSensor(motionListener, motionSensor);
            TrackingStore.log(this, "止まっているので測位を間引いた（3分間 歩数が増えず、30m以上動いていない）");
        } else {
            stillMs += now - stillSince;
            if (motionSensor != null) sensors.cancelTriggerSensor(motionListener, motionSensor);
            steppedAt = now;
            movedAt = now;
            TrackingStore.log(this, String.format(Locale.JAPAN, "%sので測位を戻した（%.0f分 間引いた）", why, (now - stillSince) / 60_000.0));
        }
        requestUpdates();
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        long at = event.timestamp / 1_000_000;
        if (event.sensor.getType() == Sensor.TYPE_STEP_COUNTER) {
            onSteps((long) event.values[0]);
            if (steps >= 0) remember(stepSamples, at, steps);
            return;
        }
        double v = event.values[0];
        // 1秒ごとの小さな揺れをならす（約5秒の移動平均に相当）
        hPa = Double.isNaN(hPa) ? v : hPa + (v - hPa) * 0.2;
        hPaAt = System.currentTimeMillis() - (SystemClock.elapsedRealtimeNanos() - event.timestamp) / 1_000_000;
        latestHPa = hPa;
        latestHPaAt = hPaAt;
        remember(hPaSamples, at, hPa);
    }

    /** 直近の気圧と歩数（[時刻（elapsedRealtime の ms）, 値]）。測位はまとめて届くので、点ごとにその時刻の値を引くのに使う */
    private final ArrayDeque<double[]> hPaSamples = new ArrayDeque<>();
    private final ArrayDeque<double[]> stepSamples = new ArrayDeque<>();
    /** 覚えておく長さ（測位がまとめて届く最大の遅れ MAX_DELAY_MS より十分長く） */
    private static final long SAMPLE_KEEP_MS = 60_000;

    private static void remember(ArrayDeque<double[]> samples, long at, double value) {
        samples.addLast(new double[] { at, value });
        while (samples.size() > 1 && at - samples.peekFirst()[0] > SAMPLE_KEEP_MS) samples.pollFirst();
    }

    /** 時刻 at（elapsedRealtime の ms）の気圧。いちばん近い時刻の値（気圧計がない・近い値がなければ null） */
    private Double pressureAt(long at) {
        double[] best = null;
        for (double[] s : hPaSamples) if (best == null || Math.abs(s[0] - at) < Math.abs(best[0] - at)) best = s;
        return best != null && Math.abs(best[0] - at) < PRESSURE_STALE_MS ? best[1] : null;
    }

    /** 時刻 at の歩数（記録を始めてからの歩数）：その時刻までに数えた値。前の値がなければ、覚えているいちばん古い値（歩数計がなければ null） */
    private Long stepsAt(long at) {
        if (steps < 0) return null;
        double[] found = null;
        for (double[] s : stepSamples) {
            if (s[0] > at) break;
            found = s;
        }
        if (found == null) found = stepSamples.peekFirst();
        return found != null ? (long) found[1] : steps;
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {}

    /** 記録中の記録（なければ null） */
    String currentTrack() {
        return track;
    }

    /**
     * 記録をやめる。まとめて受け取る途中の測位を出し切って保存してから止め、done を呼ぶ。
     * 止めている途中にもう一度頼まれたら、同じ止める処理が終わったときに done を呼ぶ。
     * byUser は通知の「停止」（JS がまだ知らないので、止めた時刻を残す）
     */
    void stopTracking(boolean byUser, Runnable done) {
        final int gen;
        synchronized (this) {
            if (done != null) stopWaiters.add(done);
            if (stopping) return;
            stopping = true;
            gen = generation;
        }
        String t = track;
        if (!byUser) TrackingStore.log(this, "アプリから記録を止めた");
        Runnable finish = () -> {
            boolean superseded;
            synchronized (this) {
                // 止めているあいだに次の記録が始まっていたら、その記録は止めない
                superseded = generation != gen;
            }
            if (!superseded) {
                if (t != null) {
                    summarize();
                    logBatteryUsage();
                }
                stopMeasuring();
                fused.removeLocationUpdates(callback);
                if (sensors != null) sensors.unregisterListener(this);
                track = null;
                running = null;
                latestHPa = Double.NaN;
                hPa = Double.NaN;
                hPaSamples.clear();
                stepSamples.clear();
                SharedPreferences.Editor e = prefs(this).edit()
                    .remove("track").remove("startedAt").remove("startBattery").remove("startMah").remove("startBatteryAt")
                    .remove("steps").remove("stepCounterBase").remove("stepsBase");
                if (byUser && t != null) e.putString("stoppedTrack", t).putLong("stoppedAt", System.currentTimeMillis());
                e.apply();
                if (byUser) TrackingPlugin.signal("stopped");
                ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
                stopSelf();
            }
            runStopWaiters();
        };
        if (t == null) {
            if (!handler.post(finish)) finish.run();
            return;
        }
        // flush で届く測位は記録用のスレッドで処理されるので、そのあとに止める（スレッドが終わっていればすぐ）
        fused.flushLocations().addOnCompleteListener(task -> {
            if (!handler.post(finish)) finish.run();
        });
    }

    private void runStopWaiters() {
        List<Runnable> waiters;
        synchronized (this) {
            stopping = false;
            waiters = new ArrayList<>(stopWaiters);
            stopWaiters.clear();
        }
        for (Runnable r : waiters) r.run();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // 履歴からスワイプして消された。記録は続ける
        if (track != null) TrackingStore.log(this, "アプリが履歴から消された（記録は続ける）");
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        if (track != null) TrackingStore.log(this, "記録中に記録のサービスが終了した");
        if (running == this) running = null;
        fused.removeLocationUpdates(callback);
        if (sensors != null) sensors.unregisterListener(this);
        if (sensors != null && motionSensor != null) sensors.cancelTriggerSensor(motionListener, motionSensor);
        unregister(screenReceiver);
        unregister(summaryReceiver);
        cancelSummaryAlarm();
        thread.quitSafely();
        // 止める処理を待っている呼び出しがあれば返す
        runStopWaiters();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private static String shortId(String id) {
        return id.length() > 8 ? id.substring(0, 8) : id;
    }

    /** 記録が止まったことを知らせる。タップでアプリを開くと「続きを記録しますか」と聞かれる */
    private void notifyStopped() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(ALERT_CHANNEL) == null) {
            nm.createNotificationChannel(new NotificationChannel(ALERT_CHANNEL, getString(R.string.tracking_alert_channel_name), NotificationManager.IMPORTANCE_DEFAULT));
        }
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent content = open != null
            ? PendingIntent.getActivity(this, 2, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT)
            : null;
        nm.notify(ALERT_ID, new NotificationCompat.Builder(this, ALERT_CHANNEL)
            .setSmallIcon(R.drawable.ic_tracking)
            .setColor(ContextCompat.getColor(this, R.color.tracking))
            .setContentTitle(getString(R.string.tracking_stopped_title))
            .setContentText(getString(R.string.tracking_stopped_text))
            .setContentIntent(content)
            .setAutoCancel(true)
            .build());
    }

    private void notifyProgress() {
        notifiedAt = SystemClock.elapsedRealtime();
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null && track != null) nm.notify(NOTIFICATION_ID, buildNotification(distance));
    }

    private Notification buildNotification(double meters) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, getString(R.string.tracking_channel_name), NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent content = open != null
            ? PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT)
            : null;
        PendingIntent stop = PendingIntent.getService(
            this,
            1,
            new Intent(this, TrackingService.class).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
        String km = meters < 1000
            ? String.format(Locale.JAPAN, "%d m", Math.round(meters))
            : String.format(Locale.JAPAN, "%.2f km", meters / 1000);
        return new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_tracking)
            .setColor(ContextCompat.getColor(this, R.color.tracking))
            .setContentTitle(getString(R.string.tracking_title))
            .setContentText(getString(R.string.tracking_text, km))
            // 経過時間は通知が自分で進める（書き換えなくてよい）
            .setWhen(startedAt)
            .setShowWhen(true)
            .setUsesChronometer(true)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(content)
            .addAction(0, getString(R.string.tracking_stop), stop)
            .build();
    }

    /** 記録を始める（もう同じ記録をしていれば何もしない） */
    static void start(Context context, String track, long startedAt) {
        Intent i = new Intent(context, TrackingService.class)
            .setAction(ACTION_START)
            .putExtra(EXTRA_TRACK, track)
            .putExtra(EXTRA_STARTED_AT, startedAt);
        ContextCompat.startForegroundService(context, i);
    }
}
