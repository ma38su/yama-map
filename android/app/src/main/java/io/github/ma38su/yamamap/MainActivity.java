package io.github.ma38su.yamamap;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // アプリの中で作ったプラグインは、super.onCreate より前に登録する
        registerPlugin(BarometerPlugin.class);
        registerPlugin(TrackingPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
