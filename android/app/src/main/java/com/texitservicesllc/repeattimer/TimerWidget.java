package com.texitservicesllc.repeattimer;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.os.SystemClock;
import android.text.format.DateUtils;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONObject;

/** 4x1 home-screen widget: Start, countdown, Stop. Starts with the settings saved by www/app.js. */
public class TimerWidget extends AppWidgetProvider {
    private static final long DAY = 24 * 60 * 60 * 1000L;
    private static final int TRIAL_DAYS = 7; // same as TRIAL_DAYS in www/app.js

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) { refresh(ctx); }

    /** Capacitor Preferences stores each key as a JSON string in this SharedPreferences file. */
    private static JSONObject saved(Context ctx, String key) {
        try {
            String v = ctx.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE).getString(key, null);
            return v != null ? new JSONObject(v) : new JSONObject();
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    /** TimerService start intent built from the saved settings (defaults match DEFAULTS in app.js). */
    static Intent startIntent(Context ctx) {
        JSONObject s = saved(ctx, "settings");
        JSONObject ent = saved(ctx, "ent");
        long trialStart = ent.optLong("trialStart", 0);
        boolean unlocked = ent.optBoolean("purchased", false)
                || (trialStart > 0 && System.currentTimeMillis() < trialStart + TRIAL_DAYS * DAY);
        long durationMs = s.optLong("duration", 180) * 1000;
        long restMs = s.optLong("rest", 5) * 1000;
        boolean leadIn = s.optBoolean("leadIn", false) && restMs > 0;
        return new Intent(ctx, TimerService.class).setAction(TimerService.ACTION_START)
                .putExtra("durationMs", durationMs)
                .putExtra("restMs", restMs)
                .putExtra("repeat", s.optBoolean("repeat", false) && unlocked) // Repeat is a paid feature
                .putExtra("sound", s.optBoolean("sound", true))
                .putExtra("vibrate", s.optBoolean("vibrate", true))
                .putExtra("leadIn", leadIn)
                .putExtra("soundType", s.optString("soundType", "bowl"))
                .putExtra("phaseEnd", System.currentTimeMillis() + (leadIn ? restMs : durationMs));
    }

    /** Redraw every placed widget from the service's last state. */
    static void refresh(Context ctx) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, TimerWidget.class));
        if (ids.length == 0) return;

        JSONObject st = TimerService.lastState();
        String state = st.optString("state", "idle");
        int round = st.optInt("round", 0);
        boolean running = "work".equals(state) || "rest".equals(state);

        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget);
        String label = "rest".equals(state) ? (round == 0 ? "Get ready" : "Resting")
                : "work".equals(state) ? (st.optBoolean("repeat", false) ? "Round " + round : "")
                : "done".equals(state) ? "Done" : "";
        v.setTextViewText(R.id.widget_label, label);
        v.setViewVisibility(R.id.widget_label, label.isEmpty() ? View.GONE : View.VISIBLE);

        if (running) {
            // Chronometer counts on the launcher's side, so the widget needs no per-second updates.
            long base = SystemClock.elapsedRealtime() + (st.optLong("phaseEnd", 0) - System.currentTimeMillis());
            v.setChronometer(R.id.widget_time, base, null, true);
            v.setChronometerCountDown(R.id.widget_time, true);
            v.setTextColor(R.id.widget_time, "rest".equals(state) ? Color.parseColor("#f2b233") : Color.WHITE);
            v.setViewVisibility(R.id.widget_time, View.VISIBLE);
            v.setViewVisibility(R.id.widget_idle, View.GONE);
        } else {
            // A stopped Chronometer drifts when the launcher redraws it, so idle uses plain text.
            // Same format the Chronometer uses (00:00), so the digits don't shift on Start.
            v.setTextViewText(R.id.widget_idle, DateUtils.formatElapsedTime(saved(ctx, "settings").optLong("duration", 180)));
            v.setViewVisibility(R.id.widget_time, View.GONE);
            v.setViewVisibility(R.id.widget_idle, View.VISIBLE);
        }

        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        Intent start = new Intent(ctx, TimerService.class).setAction(TimerService.ACTION_WIDGET_START);
        Intent stop = new Intent(ctx, TimerService.class).setAction(TimerService.ACTION_STOP);
        Intent open = new Intent(ctx, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        v.setOnClickPendingIntent(R.id.widget_start, PendingIntent.getForegroundService(ctx, 10, start, flags));
        v.setOnClickPendingIntent(R.id.widget_stop, PendingIntent.getService(ctx, 11, stop, flags));
        v.setOnClickPendingIntent(R.id.widget_center, PendingIntent.getActivity(ctx, 12, open, flags));
        mgr.updateAppWidget(ids, v);
    }
}
