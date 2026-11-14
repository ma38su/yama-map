package io.github.ma38su.yamamap;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.SystemClock;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 気圧計（src/track/barometer.ts から使う）。
 * 記録中は start() で聞き始め、点を記録するたびに read() で最新の気圧を読む。
 * 気圧はゆっくりしか変わらないので、1秒に1回・最大10秒まとめて届けてもらう（電池のため）。
 * 画面を消してもアプリの記録（バックグラウンド測位）が動いているあいだは聞き続ける
 */
@CapacitorPlugin(name = "Barometer")
public class BarometerPlugin extends Plugin implements SensorEventListener {
    private SensorManager sensorManager;
    private Sensor sensor;
    private boolean listening = false;
    /** なめらかにした気圧 (hPa)。まだ届いていなければ NaN */
    private double hPa = Double.NaN;
    /** 最後に届いた時刻（エポックミリ秒） */
    private long readAt = 0;

    @Override
    public void load() {
        sensorManager = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
        sensor = sensorManager != null ? sensorManager.getDefaultSensor(Sensor.TYPE_PRESSURE) : null;
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", sensor != null);
        call.resolve(ret);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (sensor == null) {
            call.reject("気圧計がありません");
            return;
        }
        if (!listening) {
            listening = sensorManager.registerListener(this, sensor, 1_000_000, 10_000_000);
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopListening();
        call.resolve();
    }

    @PluginMethod
    public void read(PluginCall call) {
        // まとめて届けてもらっている分を出してもらう（次の read に間に合う）
        if (listening) sensorManager.flush(this);
        JSObject ret = new JSObject();
        if (Double.isNaN(hPa)) ret.put("hPa", JSObject.NULL);
        else ret.put("hPa", hPa);
        ret.put("t", readAt);
        call.resolve(ret);
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        double v = event.values[0];
        // 1秒ごとの値の小さな揺れをならす（約5秒の移動平均に相当）
        hPa = Double.isNaN(hPa) ? v : hPa + (v - hPa) * 0.2;
        // event.timestamp は起動からのナノ秒なので、エポックミリ秒に直す
        readAt = System.currentTimeMillis() - (SystemClock.elapsedRealtimeNanos() - event.timestamp) / 1_000_000;
    }

    @Override
    public void onAccuracyChanged(Sensor s, int accuracy) {}

    private void stopListening() {
        if (listening) sensorManager.unregisterListener(this);
        listening = false;
        hPa = Double.NaN;
    }

    @Override
    protected void handleOnDestroy() {
        stopListening();
    }
}
