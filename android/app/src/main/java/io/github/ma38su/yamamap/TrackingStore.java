package io.github.ma38su.yamamap;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.location.Location;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

/**
 * 記録中の測位を端末に保存する（TrackingService が書き、TrackingPlugin が JS へ渡す）。
 * WebView が止まっていても点が欠けないよう、届いた測位はその場でここに入れる。
 * JS は表に出たときに取り込んで IndexedDB に保存し、記録を終えたら消す。
 */
class TrackingStore extends SQLiteOpenHelper {
    private static TrackingStore instance;

    static synchronized TrackingStore get(Context context) {
        if (instance == null) instance = new TrackingStore(context.getApplicationContext());
        return instance;
    }

    private TrackingStore(Context context) {
        super(context, "tracking.db", null, 1);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL(
            "CREATE TABLE fixes (id INTEGER PRIMARY KEY AUTOINCREMENT, track TEXT NOT NULL, t INTEGER NOT NULL," +
            " lat REAL NOT NULL, lng REAL NOT NULL, acc REAL NOT NULL, alt REAL, hpa REAL)"
        );
        db.execSQL("CREATE INDEX fixes_track ON fixes (track, id)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {}

    /** hpa は気圧 (hPa)。気圧計がない・値が古ければ null */
    void add(String track, Location loc, Double hpa) {
        ContentValues v = new ContentValues();
        v.put("track", track);
        v.put("t", loc.getTime());
        v.put("lat", loc.getLatitude());
        v.put("lng", loc.getLongitude());
        v.put("acc", loc.hasAccuracy() ? loc.getAccuracy() : 9999);
        if (loc.hasAltitude()) v.put("alt", loc.getAltitude());
        if (hpa != null) v.put("hpa", hpa);
        getWritableDatabase().insert("fixes", null, v);
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
