package com.texitservicesllc.repeattimer;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

import com.getcapacitor.JSObject;

/**
 * Owns the timer while it runs, so cues fire with the screen locked.
 * Same state machine as www/app.js; phases are scheduled from the previous
 * phase end (wall clock), so there is no drift.
 */
public class TimerService extends Service {
    static final String ACTION_START = "com.texitservicesllc.repeattimer.START";
    static final String ACTION_STOP = "com.texitservicesllc.repeattimer.STOP";
    private static final String CHANNEL = "timer";
    private static final int NOTIF_ID = 1;

    interface Listener { void onState(JSObject s); }

    static Listener listener;
    static TimerService instance;
    private static JSObject last = idle();

    private String state = "idle";
    private long phaseEnd;
    private int round;
    private long durationMs;
    private long restMs;
    private boolean repeat;
    private boolean sound = true;
    private boolean vibrate = true;
    private String soundType = "bowl";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable tick = this::onTick;
    private PowerManager.WakeLock wakeLock;

    static JSObject idle() {
        JSObject o = new JSObject();
        o.put("state", "idle");
        o.put("phaseEnd", 0);
        o.put("round", 0);
        return o;
    }

    static JSObject lastState() { return last; }

    @Override
    public void onCreate() {
        super.onCreate();
        Sounds.init(this);
        instance = this;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopTimer();
            return START_NOT_STICKY;
        }
        if (intent == null) { stopSelf(); return START_NOT_STICKY; }

        durationMs = intent.getLongExtra("durationMs", 180000);
        restMs = intent.getLongExtra("restMs", 5000);
        repeat = intent.getBooleanExtra("repeat", false);
        sound = intent.getBooleanExtra("sound", true);
        vibrate = intent.getBooleanExtra("vibrate", true);
        String st = intent.getStringExtra("soundType");
        soundType = st != null ? st : "bowl";
        phaseEnd = intent.getLongExtra("phaseEnd", System.currentTimeMillis() + durationMs);
        boolean leadIn = intent.getBooleanExtra("leadIn", false) && restMs > 0;
        // Lead-in: count down the rest gap first (round 0); round 1 then starts with the resume cue.
        round = leadIn ? 0 : 1;
        state = leadIn ? "rest" : "work";

        goForeground();
        acquireWakeLock();
        if (!leadIn) cue("start");
        schedule();
        emit();
        return START_NOT_STICKY;
    }

    void applyUpdate(boolean repeat, long restMs, boolean sound, String soundType, boolean vibrate) {
        this.repeat = repeat;
        this.restMs = restMs;
        this.sound = sound;
        this.soundType = soundType;
        this.vibrate = vibrate;
        if (running()) { updateNotification(); emit(); }
    }

    /** Restart the current round from full time; ignored outside a round. */
    void restartRound(long newPhaseEnd) {
        if (!"work".equals(state)) return;
        phaseEnd = newPhaseEnd > 0 ? newPhaseEnd : System.currentTimeMillis() + durationMs;
        cue("start");
        schedule();
        updateNotification();
        emit();
    }

    void stopTimer() {
        state = "idle";
        round = 0;
        emit();
        shutdown();
    }

    private boolean running() { return "work".equals(state) || "rest".equals(state); }

    private void onTick() {
        String c = null;
        while (running() && System.currentTimeMillis() >= phaseEnd) c = advance();
        if (c != null) cue(c);
        emit();
        if (running()) {
            schedule();
            updateNotification();
        } else {
            shutdown();
        }
    }

    private String advance() {
        if ("work".equals(state)) {
            if (!repeat) { state = "done"; return "end"; }
            if (restMs > 0) {
                state = "rest";
                phaseEnd += restMs;
            } else {
                round++;
                phaseEnd += durationMs;
            }
            return "end";
        }
        if ("rest".equals(state)) {
            state = "work";
            round++;
            phaseEnd += durationMs;
            return "resume";
        }
        return null;
    }

    private void schedule() {
        handler.removeCallbacks(tick);
        if (running()) handler.postDelayed(tick, Math.max(0, phaseEnd - System.currentTimeMillis()));
    }

    private void cue(String kind) {
        if (sound) Sounds.play(soundType, kind);
        if (vibrate) {
            long ms = "end".equals(kind) ? 600 : ("resume".equals(kind) ? 300 : 150);
            Vibrator v = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            if (v != null && v.hasVibrator()) {
                if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE));
                else v.vibrate(ms);
            }
        }
    }

    private void emit() {
        JSObject o = new JSObject();
        o.put("state", state);
        o.put("phaseEnd", phaseEnd);
        o.put("round", round);
        last = o;
        if (listener != null) listener.onState(o);
    }

    // ---------- foreground notification ----------

    private void goForeground() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Timer", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shows the running timer");
            ch.setSound(null, null);
            getSystemService(NotificationManager.class).createNotificationChannel(ch);
        }
        int type = Build.VERSION.SDK_INT >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE : 0;
        ServiceCompat.startForeground(this, NOTIF_ID, buildNotification(), type);
    }

    private void updateNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIF_ID, buildNotification());
    }

    private Notification buildNotification() {
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPi = PendingIntent.getActivity(this, 0, open, piFlags);
        Intent stop = new Intent(this, TimerService.class).setAction(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(this, 1, stop, piFlags);

        String title = "rest".equals(state) ? (round == 0 ? "Get ready" : "Resting") : (repeat ? "Round " + round : "Timer running");
        return new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_timer)
                .setContentTitle(title)
                .setWhen(phaseEnd)
                .setShowWhen(true)
                .setUsesChronometer(true)
                .setChronometerCountDown(true)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setCategory(NotificationCompat.CATEGORY_STOPWATCH)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .setContentIntent(openPi)
                .addAction(0, "Stop", stopPi)
                .build();
    }

    // ---------- lifecycle ----------

    private void acquireWakeLock() {
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "RepeatTimer:run");
            wakeLock.setReferenceCounted(false);
        }
        wakeLock.acquire(12 * 60 * 60 * 1000L);
    }

    private void shutdown() {
        handler.removeCallbacks(tick);
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(tick);
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (instance == this) instance = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
