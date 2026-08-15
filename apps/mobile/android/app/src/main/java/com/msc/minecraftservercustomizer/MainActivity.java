package com.msc.minecraftservercustomizer;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DeviceInfoPlugin.class);
        registerPlugin(StoragePlugin.class);
        registerPlugin(JavaRuntimePlugin.class);
        registerPlugin(HostingProcessPlugin.class);
        registerPlugin(VanillaServerPlugin.class);
        registerPlugin(ServerManagementPlugin.class);
        registerPlugin(ModdedServerPlugin.class);
        registerPlugin(ConnectivityPlugin.class);
        registerPlugin(DirectTransportPlugin.class);
        registerPlugin(PlayitResearchPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
