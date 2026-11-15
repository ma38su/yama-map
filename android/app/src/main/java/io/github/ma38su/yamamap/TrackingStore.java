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
    /** ログに残す行数（「動作の記録」はこの行数まで読む：src/track/location.ts） */
    private static final int LOG_KEEP = 2000;
    /** 1歩で進める長さの上限と、歩数で説明できない動きを数える誤差の倍率（src/track/recorder.ts と同じ） */
    private static final float MAX_STRIDE_M = 1.2f;
    static final float UNEXPLAINED_ACCURACY_FACTOR = 2;

    /**
     * 前に数えた点から d (m) 離れた測位を、動いたとみなすか（src/track/recorder.ts の countsAsMove と同じ決まり）。
     * 歩数（1歩 MAX_STRIDE_M まで）で説明できる動きはふだんどおり数え、説明できない分（屋内・山小屋の GPS のぶれ）は
     * 誤差の和の UNEXPLAINED_ACCURACY_FACTOR 倍を超えたときだけ数える（乗り物は数える）。steps はそのあいだの歩数（歩数計がなければ null）
     */
    static boolean countsAsMove(float d, float lastAcc, float acc, Long steps, float minStep) {
        if (d < Math.max(minStep, acc / 2)) return false;
        if (steps == null) return true;
        float walked = steps * MAX_STRIDE_M;
        return d <= walked || d - walked >= UNEXPLAINED_ACCURACY_FACTOR * (lastAcc + acc);
    }

    /** from から to までの歩数（どちらかがない・歩数計が数え直されて減っていれば null） */
    static Long stepsBetween(Long from, Long to) {
        return from != null && to != null && to >= from ? to - from : null;
    }

    private TrackingStore(Context context) {
        super(context, "tracking.db", null, 3);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL(
            "CREATE TABLE fixes (id INTEGER PRIMARY KEY AUTOINCREMENT, track TEXT NOT NULL, t INTEGER NOT NULL," +
            " lat REAL NOT NULL, lng REAL NOT NULL, acc REAL NOT NULL, alt REAL, hpa REAL, steps INTEGER)"
        );
        db.execSQL("CREATE INDEX fixes_track ON fixes (track, id)");
        createLog(db);
    }

    /** 版を上げるときは、表・列を足すだけにする（アプリを更新しても、取り込む前の測位が消えないように） */
    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        if (oldVersion < 2) createLog(db);
        // 版3：測位のときの歩数（記録を始めてからの歩数）
        if (oldVersion < 3) db.execSQL("ALTER TABLE fixes ADD COLUMN steps INTEGER");
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
        long id = db.insert("log", null, v);
        // 古い行は、50行ごとにまとめて消す。数えるのは行の番号で（プロセスごとに数え直すと、短い記録が続いたときに消されないまま増えるため）
        if (id > 0 && id % 50 == 0) db.execSQL("DELETE FROM log WHERE id <= " + (id - LOG_KEEP));
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

    /**
     * 1回に届いた測位をまとめて保存する。hpa は点ごとの気圧 (hPa)（気圧計がない・値が古ければ null）。
     * steps は点ごとの、記録を始めてからの歩数（歩数計がない・許可がなければ null）
     */
    void addAll(String track, List<Location> locations, Double[] hpa, Long[] steps) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            for (int i = 0; i < locations.size(); i++) {
                Location loc = locations.get(i);
                ContentValues v = new ContentValues();
                v.put("track", track);
                v.put("t", loc.getTime());
                v.put("lat", loc.getLatitude());
                v.put("lng", loc.getLongitude());
                v.put("acc", loc.hasAccuracy() ? loc.getAccuracy() : 9999);
                if (loc.hasAltitude()) v.put("alt", loc.getAltitude());
                if (hpa[i] != null) v.put("hpa", hpa[i]);
                if (steps[i] != null) v.put("steps", steps[i]);
                db.insert("fixes", null, v);
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    /**
     * 記録の距離 (m) を、残っている測位から数え直す（サービスが再起動したとき、通知の距離を続きから出すため）。
     * 数え方は TrackingService と同じ（誤差 maxAccuracy 以内で、countsAsMove で動いたとみなしたとき）
     */
    double distance(String track, float maxAccuracy, float minStep) {
        double total = 0;
        double lastLat = Double.NaN;
        double lastLng = Double.NaN;
        float lastAcc = 0;
        Long lastSteps = null;
        float[] d = new float[1];
        try (Cursor c = getReadableDatabase().query("fixes", new String[] { "lat", "lng", "acc", "steps" }, "track = ?", new String[] { track }, null, null, "id")) {
            while (c.moveToNext()) {
                float acc = c.getFloat(2);
                if (acc > maxAccuracy) continue;
                double lat = c.getDouble(0);
                double lng = c.getDouble(1);
                Long steps = c.isNull(3) ? null : c.getLong(3);
                if (!Double.isNaN(lastLat)) {
                    Location.distanceBetween(lastLat, lastLng, lat, lng, d);
                    if (!countsAsMove(d[0], lastAcc, acc, stepsBetween(lastSteps, steps), minStep)) continue;
                    total += d[0];
                }
                lastLat = lat;
                lastLng = lng;
                lastAcc = acc;
                lastSteps = steps;
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

    /** track の測位のうち、番号が afterId より後で、時刻が afterT より後のものを古い順に limit 件まで */
    JSArray list(String track, long afterId, long afterT, int limit) {
        JSArray out = new JSArray();
        try (Cursor c = getReadableDatabase().query(
            "fixes",
            new String[] { "id", "t", "lat", "lng", "acc", "alt", "hpa", "steps" },
            "track = ? AND id > ? AND t > ?",
            new String[] { track, String.valueOf(afterId), String.valueOf(afterT) },
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
                f.put("steps", c.isNull(7) ? JSObject.NULL : c.getLong(7));
                out.put(f);
            }
        }
        return out;
    }

    void clear(String track) {
        getWritableDatabase().delete("fixes", "track = ?", new String[] { track });
    }
}
