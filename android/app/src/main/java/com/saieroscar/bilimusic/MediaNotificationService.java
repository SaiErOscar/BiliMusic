package com.saieroscar.bilimusic;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * v1.4.7-pre4 通知栏媒体控制：前台服务持有 MediaSessionCompat + MediaStyle 通知
 * （上一曲/播放暂停/下一曲），系统媒体控件（通知栏、锁屏）由此驱动。
 * WebView 内的 audio 元素仍是真正的播放器：服务只把用户指令回抛给 JS
 * （经 MediaSessionPlugin 的 mediaCommand 事件），JS 侧执行后回推新状态。
 * 局限：Activity 退到后台后 WebView 音频可能被系统暂停，彻底后台播放需要
 * 原生播放器（ExoPlayer）承载音频，属后续版本。
 */
public class MediaNotificationService extends Service {

    public static final String CHANNEL_ID = "bilimusic_media";
    public static final int NOTIFICATION_ID = 42;
    public static final String ACTION_UPDATE = "update";
    public static final String ACTION_STOP = "stop";
    public static final String ACTION_CMD_PLAY = "cmd_play";
    public static final String ACTION_CMD_PAUSE = "cmd_pause";
    public static final String ACTION_CMD_NEXT = "cmd_next";
    public static final String ACTION_CMD_PREV = "cmd_prev";

    public interface MediaCommandListener {
        void onCommand(String action, double value);
    }

    private static volatile MediaCommandListener commandListener;

    public static void setCommandListener(MediaCommandListener l) {
        commandListener = l;
    }

    private MediaSessionCompat session;
    private final Handler main = new Handler();
    private final ExecutorService pool = Executors.newSingleThreadExecutor();
    private String coverUrl;
    private Bitmap cover;
    // 最近一次通知参数（封面加载完成后重建通知用）
    private String lastTitle = "";
    private String lastArtist = "";
    private boolean lastPlaying = false;

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        session = new MediaSessionCompat(this, "BiliMusic");
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override
            public void onPlay() { emit("play", 0); }
            @Override
            public void onPause() { emit("pause", 0); }
            @Override
            public void onSkipToNext() { emit("next", 0); }
            @Override
            public void onSkipToPrevious() { emit("previous", 0); }
            @Override
            public void onSeekTo(long pos) { emit("seek", pos / 1000.0); }
        });
        session.setActive(true);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (action == null || ACTION_STOP.equals(action)) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_CMD_PLAY.equals(action)) { emit("play", 0); return START_NOT_STICKY; }
        if (ACTION_CMD_PAUSE.equals(action)) { emit("pause", 0); return START_NOT_STICKY; }
        if (ACTION_CMD_NEXT.equals(action)) { emit("next", 0); return START_NOT_STICKY; }
        if (ACTION_CMD_PREV.equals(action)) { emit("previous", 0); return START_NOT_STICKY; }

        // ACTION_UPDATE：用 extras 刷新会话与通知
        lastTitle = intent.getStringExtra("title");
        lastArtist = intent.getStringExtra("artist");
        lastPlaying = intent.getBooleanExtra("isPlaying", false);
        long positionMs = (long) (intent.getDoubleExtra("positionSec", 0) * 1000);
        long durationMs = (long) (intent.getDoubleExtra("durationSec", 0) * 1000);
        String newCover = intent.getStringExtra("coverUrl");

        MediaMetadataCompat.Builder md = new MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, lastTitle == null ? "" : lastTitle)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, lastArtist == null ? "" : lastArtist);
        if (cover != null) md.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, cover);
        session.setMetadata(md.build());
        session.setPlaybackState(new PlaybackStateCompat.Builder()
                .setActions(PlaybackStateCompat.ACTION_PLAY
                        | PlaybackStateCompat.ACTION_PAUSE
                        | PlaybackStateCompat.ACTION_PLAY_PAUSE
                        | PlaybackStateCompat.ACTION_SEEK_TO
                        | PlaybackStateCompat.ACTION_SKIP_TO_NEXT
                        | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS)
                .setState(lastPlaying ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED,
                        positionMs, lastPlaying ? 1f : 0f)
                .build());

        startForeground(NOTIFICATION_ID, buildNotification());

        if (newCover != null && !newCover.isEmpty() && !newCover.equals(coverUrl)) {
            coverUrl = newCover;
            pool.execute(this::fetchCover);
        }
        return START_NOT_STICKY;
    }

    private void fetchCover() {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(coverUrl).openConnection();
            conn.setConnectTimeout(10_000);
            conn.setReadTimeout(15_000);
            conn.connect();
            try (InputStream in = conn.getInputStream()) {
                Bitmap bmp = BitmapFactory.decodeStream(in);
                if (bmp != null) {
                    cover = bmp;
                    main.post(() -> {
                        MediaMetadataCompat.Builder md = new MediaMetadataCompat.Builder()
                                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, lastTitle)
                                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, lastArtist)
                                .putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, cover);
                        if (session != null) session.setMetadata(md.build());
                        try {
                            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
                            nm.notify(NOTIFICATION_ID, buildNotification());
                        } catch (Exception ignored) { }
                    });
                }
            }
        } catch (Exception ignored) { } finally {
            // 连接必须释放（pre6）：封面随每次切曲加载，不 disconnect 会持续占用 socket 池
            if (conn != null) conn.disconnect();
        }
    }

    private Notification buildNotification() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "BiliMusic 播放", NotificationManager.IMPORTANCE_LOW);
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(ch);
        }
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent openPi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Action prev = new NotificationCompat.Action(
                android.R.drawable.ic_media_previous, "上一曲", cmdPi(ACTION_CMD_PREV, 1));
        NotificationCompat.Action playPause = new NotificationCompat.Action(
                lastPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                lastPlaying ? "暂停" : "播放", cmdPi(lastPlaying ? ACTION_CMD_PAUSE : ACTION_CMD_PLAY, 2));
        NotificationCompat.Action next = new NotificationCompat.Action(
                android.R.drawable.ic_media_next, "下一曲", cmdPi(ACTION_CMD_NEXT, 3));

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentTitle(lastTitle)
                .setContentText(lastArtist)
                .setContentIntent(openPi)
                .setOnlyAlertOnce(true)
                .setOngoing(lastPlaying)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .addAction(prev)
                .addAction(playPause)
                .addAction(next)
                .setStyle(new androidx.media.app.NotificationCompat.MediaStyle()
                        .setMediaSession(session.getSessionToken())
                        .setShowActionsInCompactView(0, 1, 2))
                .build();
    }

    private PendingIntent cmdPi(String action, int requestCode) {
        Intent i = new Intent(this, getClass()).setAction(action);
        return PendingIntent.getService(this, requestCode, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void emit(String action, double value) {
        MediaCommandListener l = commandListener;
        if (l != null) main.post(() -> l.onCommand(action, value));
    }

    @Override
    public void onDestroy() {
        if (session != null) {
            session.setActive(false);
            session.release();
            session = null;
        }
        super.onDestroy();
    }
}
