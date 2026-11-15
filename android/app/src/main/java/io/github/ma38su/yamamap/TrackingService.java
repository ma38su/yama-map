package io.github.ma38su.yamamap;

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
import android.content.pm.ServiceInfo;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.Location;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Handler;
import android.os.PowerManager;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.SystemClock;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/**
 * 軌跡の記録（フォアグラウンドサービス）。届いた測位はその場で TrackingStore に保存し、WebView が動いていれば JS に知らせる。
 * アプリの画面（Activity）や WebView とは結び付けていないので、履歴からスワイプして消しても、
 * WebView が止められても記録は続く。止めるのはアプリの「記録終了」か、通知の「停止」だけ。
 *  - 測位は1秒間隔・5m 動いたときだけ。最大20秒ぶんまとめて受け取る（その間 CPU を眠らせておける）
 *  - 気圧計があれば、気圧も点と一緒に残す（JS の気圧高度計で標高を補う）
 *  - システムに止められて再起動されたら（START_STICKY）、記録中だった記録を続ける
 *  - あとでパフォーマンスを分析できるよう、10分ごとに「計測」の1行をログに残す（電池・温度・測位の届き具合・画面が点いていた時間など）
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
    private static final long INTERVAL_MS = 1000;
    private static final float MIN_DISTANCE_M = 5;
    private static final long MAX_DELAY_MS = 20_000;
    /** 通知の距離に数える測位（JS の記録と同じく、誤差40m以内・8m以上動いたとき） */
    private static final float COUNT_ACCURACY_M = 40;
    private static final float COUNT_STEP_M = 8;
    /** これより古い気圧は点に付けない */
    private static final long PRESSURE_STALE_MS = 2 * 60_000;

    /** 動いているサービス（なければ null）。TrackingPlugin が止めるときに使う */
    static volatile TrackingService running;

    private FusedLocationProviderClient fused;
    private HandlerThread thread;
    private Handler handler;
    private String track;
    private long startedAt;
    private double distance;
    private Location counted;
    private long notifiedAt;
    private SensorManager sensors;
    private double hPa = Double.NaN;
    private long hPaAt;
    // ---------- 計測（前回ログにまとめてから） ----------
    /** 届いた測位の数と、受け取った回数（まとめて届くので、回数のほうが少ない） */
    private int received;
    private int deliveries;
    private final List<Float> accuracies = new ArrayList<>();
    private long summarizedAt;
    /** 画面が点いていた時間 (ms)。点いているあいだは screenOnSince に点いた時刻 */
    private long screenOnMs;
    private long screenOnSince;
    private final Runnable summaryTask = this::summarize;
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
            TrackingStore store = TrackingStore.get(TrackingService.this);
            Double p = !Double.isNaN(hPa) && System.currentTimeMillis() - hPaAt < PRESSURE_STALE_MS ? hPa : null;
            deliveries++;
            for (Location loc : result.getLocations()) {
                store.add(t, loc, p);
                received++;
                if (loc.hasAccuracy()) accuracies.add(loc.getAccuracy());
                if (loc.hasAccuracy() && loc.getAccuracy() <= COUNT_ACCURACY_M) {
                    if (counted == null) counted = loc;
                    else if (loc.distanceTo(counted) >= COUNT_STEP_M) {
                        distance += loc.distanceTo(counted);
                        counted = loc;
                    }
                }
            }
            prefs(TrackingService.this).edit().putFloat("distance", (float) distance).apply();
            TrackingPlugin.signal("fixes");
            // 距離の表示は1分に1回まで書き換える（経過時間は通知が自分で進める）
            if (SystemClock.elapsedRealtime() - notifiedAt > 60_000) notifyProgress();
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
        boolean resumed = id.equals(p.getString("track", null));
        TrackingStore.log(this, restarted
            ? "システムに止められたあと、記録のサービスが再起動した（記録 " + shortId(id) + " を続ける）"
            : "記録のサービスを開始（記録 " + shortId(id) + "・" + (resumed ? "続き" : "新規") + "）");
        track = id;
        startedAt = since;
        distance = resumed ? p.getFloat("distance", 0) : 0;
        counted = null;
        p.edit()
            .putString("track", id)
            .putLong("startedAt", since)
            .putFloat("distance", (float) distance)
            .remove("stoppedTrack")
            .remove("stoppedAt")
            .apply();
        try {
            int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION : 0;
            ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), type);
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
        startMeasuring(!resumed || restarted);
        requestUpdates();
        startPressure();
        return START_STICKY;
    }

    private void requestUpdates() {
        LocationRequest request = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, INTERVAL_MS)
            .setMinUpdateDistanceMeters(MIN_DISTANCE_M)
            .setMaxUpdateDelayMillis(MAX_DELAY_MS)
            .build();
        try {
            fused.requestLocationUpdates(request, callback, thread.getLooper());
        } catch (SecurityException e) {
            Log.e(TAG, "位置情報の許可がありません", e);
            TrackingStore.log(this, "位置情報の許可がないので記録を止めた: " + e.getMessage());
            notifyStopped();
            stopTracking(false, null);
        }
    }

    // ---------- 計測 ----------

    /** 計測を始める。新しい記録なら、記録全体の電池の減りを出すために、始めの電池残量を残す */
    private void startMeasuring(boolean fresh) {
        summarizedAt = SystemClock.elapsedRealtime();
        received = 0;
        deliveries = 0;
        accuracies.clear();
        screenOnMs = 0;
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        screenOnSince = pm != null && pm.isInteractive() ? summarizedAt : 0;
        IntentFilter f = new IntentFilter(Intent.ACTION_SCREEN_ON);
        f.addAction(Intent.ACTION_SCREEN_OFF);
        try {
            unregisterReceiver(screenReceiver);
        } catch (IllegalArgumentException ignored) {
            // まだ登録していない
        }
        ContextCompat.registerReceiver(this, screenReceiver, f, ContextCompat.RECEIVER_NOT_EXPORTED);
        SharedPreferences p = prefs(this);
        if (fresh || !p.contains("startBattery")) {
            p.edit().putInt("startBattery", batteryPercent()).putLong("startBatteryAt", System.currentTimeMillis()).apply();
        }
        handler.removeCallbacks(summaryTask);
        handler.postDelayed(summaryTask, SUMMARY_MS);
        TrackingStore.log(this, "計測 開始 " + deviceState());
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
        TrackingStore.log(this, String.format(Locale.JAPAN,
            "計測 区間=%d分 測位=%d件 受信=%d回 精度(中央/最大)=%s 画面オン=%.1f分 距離=%.0fm 気圧=%s %s",
            Math.round((now - summarizedAt) / 60_000.0), received, deliveries, acc, screen / 60_000.0, distance,
            !Double.isNaN(hPa) ? String.format(Locale.JAPAN, "%.1fhPa", hPa) : "なし", deviceState()));
        summarizedAt = now;
        received = 0;
        deliveries = 0;
        accuracies.clear();
        handler.postDelayed(summaryTask, SUMMARY_MS);
    }

    /** 電池残量・温度・充電・発熱・省電力モード */
    private String deviceState() {
        Intent b = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        float temp = b != null ? b.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) / 10f : Float.NaN;
        boolean plugged = b != null && b.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0;
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        String thermal = pm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? String.valueOf(pm.getCurrentThermalStatus()) : "-";
        return String.format(Locale.JAPAN, "電池=%d%% 温度=%.1f℃ 充電=%s 発熱=%s 省電力=%s",
            batteryPercent(), temp, plugged ? "中" : "なし", thermal, pm != null && pm.isPowerSaveMode() ? "オン" : "オフ");
    }

    private int batteryPercent() {
        BatteryManager bm = (BatteryManager) getSystemService(Context.BATTERY_SERVICE);
        return bm != null ? bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) : -1;
    }

    /** 記録全体の電池の減り（記録を終えたとき） */
    private void logBatteryUsage() {
        SharedPreferences p = prefs(this);
        int start = p.getInt("startBattery", -1);
        long at = p.getLong("startBatteryAt", 0);
        int end = batteryPercent();
        double hours = (System.currentTimeMillis() - at) / 3_600_000.0;
        if (start < 0 || end < 0 || hours <= 0) return;
        TrackingStore.log(this, String.format(Locale.JAPAN,
            "計測 記録全体 電池=%d%%→%d%% 時間=%.1f時間 1時間あたり=%.1f%% 距離=%.0fm（途中で充電していれば正しくない）",
            start, end, hours, (start - end) / hours, distance));
    }

    private void stopMeasuring() {
        handler.removeCallbacks(summaryTask);
        try {
            unregisterReceiver(screenReceiver);
        } catch (IllegalArgumentException ignored) {
            // 登録していない
        }
    }

    private void startPressure() {
        Sensor sensor = sensors != null ? sensors.getDefaultSensor(Sensor.TYPE_PRESSURE) : null;
        // 気圧はゆっくりしか変わらないので、1秒に1回・最大10秒まとめて届けてもらう
        if (sensor != null) sensors.registerListener(this, sensor, 1_000_000, 10_000_000, handler);
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        double v = event.values[0];
        // 1秒ごとの小さな揺れをならす（BarometerPlugin と同じ）
        hPa = Double.isNaN(hPa) ? v : hPa + (v - hPa) * 0.2;
        hPaAt = System.currentTimeMillis() - (SystemClock.elapsedRealtimeNanos() - event.timestamp) / 1_000_000;
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {}

    /**
     * 記録をやめる。まとめて受け取る途中の測位を出し切って保存してから止め、done を呼ぶ。
     * byUser は通知の「停止」（JS がまだ知らないので、止めた時刻を残す）
     */
    void stopTracking(boolean byUser, Runnable done) {
        String t = track;
        if (!byUser) TrackingStore.log(this, "アプリから記録を止めた");
        Runnable finish = () -> {
            if (t != null) {
                summarize();
                logBatteryUsage();
            }
            stopMeasuring();
            fused.removeLocationUpdates(callback);
            if (sensors != null) sensors.unregisterListener(this);
            track = null;
            running = null;
            SharedPreferences.Editor e = prefs(this).edit().remove("track").remove("startedAt").remove("distance").remove("startBattery").remove("startBatteryAt");
            if (byUser && t != null) e.putString("stoppedTrack", t).putLong("stoppedAt", System.currentTimeMillis());
            e.apply();
            if (byUser) TrackingPlugin.signal("stopped");
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
            stopSelf();
            if (done != null) done.run();
        };
        if (t == null) {
            finish.run();
            return;
        }
        // flush で届く測位は thread で処理されるので、そのあとに止める
        fused.flushLocations().addOnCompleteListener(task -> handler.post(finish));
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // 履歴からスワイプして消された。記録は続ける
        if (track != null) TrackingStore.log(this, "アプリが履歴から消された（記録は続ける）");
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onTrimMemory(int level) {
        // メモリが足りなくなってきた（このあとシステムに止められることがある）
        if (level >= TRIM_MEMORY_RUNNING_LOW && track != null) TrackingStore.log(this, "メモリ不足の知らせ（level " + level + "）");
        super.onTrimMemory(level);
    }

    @Override
    public void onDestroy() {
        if (track != null) TrackingStore.log(this, "記録中に記録のサービスが終了した");
        stopMeasuring();
        if (running == this) running = null;
        fused.removeLocationUpdates(callback);
        if (sensors != null) sensors.unregisterListener(this);
        thread.quitSafely();
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
        if (nm != null && track != null) nm.notify(NOTIFICATION_ID, buildNotification());
    }

    private Notification buildNotification() {
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
        String km = distance < 1000
            ? String.format(Locale.JAPAN, "%d m", Math.round(distance))
            : String.format(Locale.JAPAN, "%.2f km", distance / 1000);
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
