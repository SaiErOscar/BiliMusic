package com.saieroscar.bilimusic;

import android.annotation.SuppressLint;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * v1.4.7-pre4 Android 下载入库：音频经 HttpURLConnection 下载后写入
 * MediaStore Downloads（BiliMusic/ 子目录），系统文件管理器与音乐 App 可见。
 * API 29 以下回退应用专属外部目录（始终可写、无需存储权限）。
 * B 站 CDN 需要 Referer/UA，由调用方经 headers 传入。
 */
@CapacitorPlugin(name = "BiliMusicDownload")
public class MediaDownloadPlugin extends Plugin {

    private static final String SUB_DIR = "Music/BiliMusic";
    private final ExecutorService pool = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void downloadToMediaStore(PluginCall call) {
        final String url = call.getString("url");
        final String fileName = call.getString("fileName");
        final JSObject headers = call.getObject("headers");
        if (url == null || url.isEmpty() || fileName == null || fileName.isEmpty()) {
            call.reject("缺少 url 或 fileName");
            return;
        }
        pool.execute(() -> {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(url).openConnection();
                if (headers != null) {
                    Iterator<String> keys = headers.keys();
                    while (keys.hasNext()) {
                        String k = keys.next();
                        String v = headers.optString(k, null);
                        if (k != null && v != null) conn.setRequestProperty(k, v);
                    }
                }
                conn.setConnectTimeout(15_000);
                conn.setReadTimeout(30_000);
                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) {
                    call.reject("HTTP " + code);
                    return;
                }
                if (Build.VERSION.SDK_INT >= 29) {
                    resolveToMediaStore(call, conn, fileName);
                } else {
                    resolveToAppDir(call, conn, fileName);
                }
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "下载失败" : e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    @SuppressLint("WrongThread")
    private void resolveToMediaStore(PluginCall call, HttpURLConnection conn, String fileName) throws Exception {
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
        v.put(MediaStore.MediaColumns.MIME_TYPE, mimeFor(fileName));
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_MUSIC + "/BiliMusic");
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = getContext().getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
        if (uri == null) {
            call.reject("MediaStore 插入失败");
            return;
        }
        long total;
        try {
            try (InputStream in = conn.getInputStream(); OutputStream out = getContext().getContentResolver().openOutputStream(uri)) {
                if (out == null) throw new Exception("打开输出流失败");
                total = copy(in, out);
            }
        } catch (Exception e) {
            // 失败必须删掉 IS_PENDING=1 的占位行（pre6）：不删则留孤儿行，
            // 系统要等一周才回收 pending 条目，连续失败会堆积不可见残留
            try { getContext().getContentResolver().delete(uri, null, null); } catch (Exception ignored) { }
            throw e;
        }
        ContentValues done = new ContentValues();
        done.put(MediaStore.MediaColumns.IS_PENDING, 0);
        getContext().getContentResolver().update(uri, done, null, null);
        JSObject ret = new JSObject();
        ret.put("filePath", uri.toString());
        ret.put("size", total);
        call.resolve(ret);
    }

    private void resolveToAppDir(PluginCall call, HttpURLConnection conn, String fileName) throws Exception {
        File dir = getContext().getExternalFilesDir(Environment.DIRECTORY_MUSIC);
        if (dir == null) dir = getContext().getFilesDir();
        File out = new File(dir, fileName);
        long total;
        try (InputStream in = conn.getInputStream(); FileOutputStream fos = new FileOutputStream(out)) {
            total = copy(in, fos);
        }
        JSObject ret = new JSObject();
        ret.put("filePath", out.getAbsolutePath());
        ret.put("size", total);
        call.resolve(ret);
    }

    private static long copy(InputStream in, OutputStream out) throws Exception {
        byte[] buf = new byte[16 * 1024];
        long total = 0;
        int n;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
            total += n;
        }
        out.flush();
        return total;
    }

    private static String mimeFor(String fileName) {
        String ext = "";
        int dot = fileName.lastIndexOf('.');
        if (dot >= 0) ext = fileName.substring(dot + 1).toLowerCase();
        switch (ext) {
            case "m4a": return "audio/mp4";
            case "flac": return "audio/flac";
            case "ogg":
            case "opus": return "audio/ogg";
            case "wav": return "audio/wav";
            default: return "audio/mpeg";
        }
    }
}
