package io.github.ma38su.yamamap;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.location.Location;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import java.util.List;

/**
 * 記録中の測位を端末に保存する（TrackingService が書き、TrackingPlugin が JS へ渡す）。
 * WebView が止まっていても点が欠けないよう、届いた測位はその場でここに入れる。
 * JS は表に出たときに取り込んで IndexedDB に保存し、記録を終えたら消す。
 * 記録のサービスの動作のログ（log）もここに残す（WebView が止まっていたあいだのことも、あとからメニューの「診断」で見られるように）。
 */
class TrackingStore extends SQLiteOpenHelper {
    private static TrackingStore instance;

    static synchronized TrackingStore get(Context context) {
        if (instance == null) instance = new TrackingStore(context.getApplicationContext());
        return instance;
    }

    private static final String TAG = "YamaTracking";
    /** ログに残す行数 */
    private static final int LOG_KEEP = 2000;
    private int logAdded = 0;

    private TrackingStore(Context context) {
        super(context, "tracking.db", null, 2);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL(
            "CREATE TABLE fixes (id INTEGER PRIMARY KEY AUTOINCREMENT, track TEXT NOT NULL, t INTEGER NOT NULL," +
            " lat REAL NOT NULL, lng REAL NOT NULL, acc REAL NOT NULL, alt REAL, hpa REAL)"
        );
        db.execSQL("CREATE INDEX fixes_track ON fixes (track, id)");
        createLog(db);
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        if (oldVersion < 2) createLog(db);
    }

    private static void createLog(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE log (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, msg TEXT NOT NULL)");
    }

    /** 動作のログを1行残す（logcat にも出す）。位置（緯度経度）は書かない */
    static void log(Context context, String msg) {
        Log.i(TAG, msg);
        try {
            get(context).addLog(msg);
        } catch (Exception e) {
            Log.w(TAG, "ログを保存できませんでした", e);
        }
    }

    private synchronized void addLog(String msg) {
        ContentValues v = new ContentValues();
        v.put("t", System.currentTimeMillis());
        v.put("msg", msg);
        SQLiteDatabase db = getWritableDatabase();
        db.insert("log", null, v);
        // 古い行は、ときどきまとめて消す
        if (++logAdded % 50 == 0) db.execSQL("DELETE FROM log WHERE id <= (SELECT MAX(id) - " + LOG_KEEP + " FROM log)");
    }

    /** 新しい順に limit 行（時刻とメッセージ） */
    JSArray logLines(int limit) {
        JSArray out = new JSArray();
        try (Cursor c = getReadableDatabase().query("log", new String[] { "t", "msg" }, null, null, null, null, "id DESC", String.valueOf(limit))) {
            while (c.moveToNext()) {
                JSObject l = new JSObject();
                l.put("t", c.getLong(0));
                l.put("msg", c.getString(1));
                out.put(l);
            }
        }
        return out;
    }

    void clearLog() {
        getWritableDatabase().delete("log", null, null);
    }

    /** まだ JS に取り込まれていない測位の数（すべての記録） */
    long pendingFixes() {
        try (Cursor c = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM fixes", null)) {
            return c.moveToFirst() ? c.getLong(0) : 0;
        }
    }

    /** 1回に届いた測位をまとめて保存する。hpa は気圧 (hPa)。気圧計がない・値が古ければ null */
    void addAll(String track, List<Location> locations, Double hpa) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            for (Location loc : locations) {
                ContentValues v = new ContentValues();
                v.put("track", track);
                v.put("t", loc.getTime());
                v.put("lat", loc.getLatitude());
                v.put("lng", loc.getLongitude());
                v.put("acc", loc.hasAccuracy() ? loc.getAccuracy() : 9999);
                if (loc.hasAltitude()) v.put("alt", loc.getAltitude());
                if (hpa != null) v.put("hpa", hpa);
                db.insert("fixes", null, v);
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    /**
     * 記録の距離 (m) を、残っている測位から数え直す（サービスが再起動したとき、通知の距離を続きから出すため）。
     * 数え方は TrackingService と同じ（誤差 maxAccuracy 以内・minStep 以上動いたとき）
     */
    double distance(String track, float maxAccuracy, float minStep) {
        double total = 0;
        double lastLat = Double.NaN;
        double lastLng = Double.NaN;
        float[] d = new float[1];
        try (Cursor c = getReadableDatabase().query("fixes", new String[] { "lat", "lng", "acc" }, "track = ?", new String[] { track }, null, null, "id")) {
            while (c.moveToNext()) {
                if (c.getDouble(2) > maxAccuracy) continue;
                double lat = c.getDouble(0);
                double lng = c.getDouble(1);
                if (Double.isNaN(lastLat)) {
                    lastLat = lat;
                    lastLng = lng;
                    continue;
                }
                Location.distanceBetween(lastLat, lastLng, lat, lng, d);
                if (d[0] < minStep) continue;
                total += d[0];
                lastLat = lat;
                lastLng = lng;
            }
        }
        return total;
    }

    /** まだ取り込まれていない測位が残っている記録の id */
    JSArray pendingTracks() {
        JSArray out = new JSArray();
        try (Cursor c = getReadableDatabase().rawQuery("SELECT DISTINCT track FROM fixes", null)) {
            while (c.moveToNext()) out.put(c.getString(0));
        }
        return out;
    }

    /** track の測位のうち、番号が afterId より後のものを古い順に limit 件まで */
    JSArray list(String track, long afterId, int limit) {
        JSArray out = new JSArray();
        try (Cursor c = getReadableDatabase().query(
            "fixes",
            new String[] { "id", "t", "lat", "lng", "acc", "alt", "hpa" },
            "track = ? AND id > ?",
            new String[] { track, String.valueOf(afterId) },
            null,
            null,
            "id",
            String.valueOf(limit)
        )) {
            while (c.moveToNext()) {
                JSObject f = new JSObject();
                f.put("id", c.getLong(0));
                f.put("t", c.getLong(1));
                f.put("lat", c.getDouble(2));
                f.put("lng", c.getDouble(3));
                f.put("acc", c.getDouble(4));
                f.put("alt", c.isNull(5) ? JSObject.NULL : c.getDouble(5));
                f.put("hpa", c.isNull(6) ? JSObject.NULL : c.getDouble(6));
                out.put(f);
            }
        }
        return out;
    }

    void clear(String track) {
        getWritableDatabase().delete("fixes", "track = ?", new String[] { track });
    }
}
