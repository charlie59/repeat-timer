package com.texitservicesllc.repeattimer;

import android.content.Intent;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** JS bridge: window.Capacitor.Plugins.RepeatTimer */
@CapacitorPlugin(name = "RepeatTimer")
public class TimerPlugin extends Plugin {

    /** PluginCall.getLong only accepts Long; JS numbers can arrive as Integer or Double. */
    private static long num(PluginCall call, String name, long def) {
        Object v = call.getData().opt(name);
        return (v instanceof Number) ? ((Number) v).longValue() : def;
    }

    @Override
    public void load() {
        Sounds.init(getContext());
        TimerService.listener = s -> notifyListeners("state", s, true);
    }

    @PluginMethod
    public void start(PluginCall call) {
        Intent i = new Intent(getContext(), TimerService.class).setAction(TimerService.ACTION_START);
        i.putExtra("phaseEnd", num(call, "phaseEnd", System.currentTimeMillis()));
        i.putExtra("durationMs", num(call, "durationMs", 180000L));
        i.putExtra("restMs", num(call, "restMs", 5000L));
        i.putExtra("repeat", call.getBoolean("repeat", false));
        i.putExtra("sound", call.getBoolean("sound", true));
        i.putExtra("vibrate", call.getBoolean("vibrate", true));
        i.putExtra("soundType", call.getString("soundType", "bowl"));
        ContextCompat.startForegroundService(getContext(), i);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        TimerService s = TimerService.instance;
        if (s != null) s.stopTimer();
        call.resolve();
    }

    @PluginMethod
    public void update(PluginCall call) {
        TimerService s = TimerService.instance;
        if (s != null) {
            s.applyUpdate(
                    call.getBoolean("repeat", false),
                    num(call, "restMs", 5000L),
                    call.getBoolean("sound", true),
                    call.getString("soundType", "bowl"),
                    call.getBoolean("vibrate", true));
        }
        call.resolve();
    }

    @PluginMethod
    public void getState(PluginCall call) {
        call.resolve(TimerService.lastState());
    }

    @PluginMethod
    public void playCue(PluginCall call) {
        Sounds.play(call.getString("soundType", "bowl"), call.getString("kind", "end"));
        call.resolve();
    }
}
