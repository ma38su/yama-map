package io.github.ma38su.yamamap;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.Location;
import android.os.Build;
import android.os.Handler;
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

import java.util.Locale;

/**
 * 軌跡の記録（フォアグラウンドサービス）。届いた測位はその場で TrackingStore に保存し、WebView が動いていれば JS に知らせる。
 * アプリの画面（Activity）や WebView とは結び付けていないので、履歴からスワイプして消しても、
 * WebView が止められても記録は続く。止めるのはアプリの「記録終了」か、通知の「停止」だけ。
 *  - 測位は1秒間隔・5m 動いたときだけ。最大20秒ぶんまとめて受け取る（その間 CPU を眠らせておける）
 *  - 気圧計があれば、気圧も点と一緒に残す（JS の気圧高度計で標高を補う）
 *  - システムに止められて再起動されたら（START_STICKY）、記録中だった記録を続ける
 */
public class TrackingService extends Service implements SensorEventListener {
    static final String ACTION_START = "io.github.ma38su.yamamap.TRACKING_START";
    static final String ACTION_STOP = "io.github.ma38su.yamamap.TRACKING_STOP";
    static final String EXTRA_TRACK = "track";
    static final String EXTRA_STARTED_AT = "startedAt";

    private static final String TAG = "YamaTracking";
    private static final String CHANNEL = "tracking";
    private static final int NOTIFICATION_ID = 1;
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

    private final LocationCallback callback = new LocationCallback() {
        @Override
        public void onLocationResult(@NonNull LocationResult result) {
            String t = track;
            if (t == null) return;
            TrackingStore store = TrackingStore.get(TrackingService.this);
            Double p = !Double.isNaN(hPa) && System.currentTimeMillis() - hPaAt < PRESSURE_STALE_MS ? hPa : null;
            for (Location loc : result.getLocations()) {
                store.add(t, loc, p);
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
            stopTracking(true, null);
            return START_NOT_STICKY;
        }
        SharedPreferences p = prefs(this);
        String id = intent != null ? intent.getStringExtra(EXTRA_TRACK) : null;
        long since = intent != null ? intent.getLongExtra(EXTRA_STARTED_AT, System.currentTimeMillis()) : 0;
        if (id == null) {
            // システムに止められたあとの再起動（intent なし）。記録中だった記録があれば続ける
            id = p.getString("track", null);
            since = p.getLong("startedAt", System.currentTimeMillis());
            if (id == null) {
                stopSelf();
                return START_NOT_STICKY;
            }
        }
        if (id.equals(track)) return START_STICKY; // もう記録している
        boolean resumed = id.equals(p.getString("track", null));
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
            track = null;
            stopSelf();
            return START_NOT_STICKY;
        }
        running = this;
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
            stopTracking(false, null);
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
        Runnable finish = () -> {
            fused.removeLocationUpdates(callback);
            if (sensors != null) sensors.unregisterListener(this);
            track = null;
            running = null;
            SharedPreferences.Editor e = prefs(this).edit().remove("track").remove("startedAt").remove("distance");
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
    public void onDestroy() {
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
