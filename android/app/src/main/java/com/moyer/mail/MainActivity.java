package com.moyer.mail;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.moyer.mail.engine.MailEnginePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 手机端收发信引擎（实现和电脑版一样的 MailApi）
        registerPlugin(MailEnginePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
