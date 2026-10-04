package com.texitservicesllc.repeattimer;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.SoundPool;

import java.util.HashMap;
import java.util.Map;

/** Preloaded cue sounds on the alarm stream (plays in silent mode, mixes over music). */
final class Sounds {
    private static SoundPool pool;
    private static final Map<String, Integer> ids = new HashMap<>();

    private Sounds() {}

    static synchronized void init(Context ctx) {
        if (pool != null) return;
        Context c = ctx.getApplicationContext();
        AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
        pool = new SoundPool.Builder().setMaxStreams(4).setAudioAttributes(attrs).build();
        ids.put("chime_start", pool.load(c, R.raw.chime_start, 1));
        ids.put("chime_end", pool.load(c, R.raw.chime_end, 1));
        ids.put("chime_resume", pool.load(c, R.raw.chime_resume, 1));
        ids.put("bowl_start", pool.load(c, R.raw.bowl_start, 1));
        ids.put("bowl_end", pool.load(c, R.raw.bowl_end, 1));
        ids.put("bowl_resume", pool.load(c, R.raw.bowl_resume, 1));
        ids.put("beep_start", pool.load(c, R.raw.beep_start, 1));
        ids.put("beep_end", pool.load(c, R.raw.beep_end, 1));
        ids.put("beep_resume", pool.load(c, R.raw.beep_resume, 1));
    }

    static synchronized void play(String type, String kind) {
        if (pool == null) return;
        Integer id = ids.get(type + "_" + kind);
        if (id == null) id = ids.get("chime_" + kind);
        if (id != null) pool.play(id, 1f, 1f, 1, 0, 1f);
    }
}
