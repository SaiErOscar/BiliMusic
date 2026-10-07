package com.saieroscar.bilimusic;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * v1.4.7-pre4 通知栏媒体控制桥：JS updateSession → 前台服务刷新 MediaSession 与通知；
 * 服务/系统媒体控件的用户指令 → mediaCommand 事件回抛 JS（play/pause/next/previous/seek）。
 * API 33+ 首次使用时请求 POST_NOTIFICATIONS，拒绝时通知不显示但会话仍工作。
 */
@CapacitorPlugin(name = "BiliMusicMedia", permissions = {
        @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
})
public class MediaSessionPlugin extends Plugin implements MediaNotificationService.MediaCommandListener {

    @Override
    public void load() {
        MediaNotificationService.setCommandListener(this);
    }

    @PluginMethod
    public void updateSession(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && !hasRequiredPermissions()) {
            // 第三参必须与 @PermissionCallback 方法名一致，否则授权回调后 call 永不 resolve，
            // updateSession 挂死、通知栏前台服务不启动（pre4 真机遗留 bug）
            requestPermissionForAlias("notifications", call, "onNotificationsPerm");
            return;
        }
        doUpdate(call);
    }

    @PermissionCallback
    private void onNotificationsPerm(PluginCall call) {
        // 拒绝也继续：会话仍运行，仅通知不可见
        doUpdate(call);
    }

    private void doUpdate(PluginCall call) {
        Intent i = new Intent(getContext(), MediaNotificationService.class);
        i.setAction(MediaNotificationService.ACTION_UPDATE);
        i.putExtra("title", call.getString("title", ""));
        i.putExtra("artist", call.getString("artist", ""));
        i.putExtra("isPlaying", call.getBoolean("isPlaying", false));
        i.putExtra("positionSec", (double) call.getFloat("positionSec", 0f));
        i.putExtra("durationSec", (double) call.getFloat("durationSec", 0f));
        i.putExtra("coverUrl", call.getString("coverUrl", ""));
        try {
            ContextCompat.startForegroundService(getContext(), i);
        } catch (Exception e) {
            // API 31+ 应用退后台（锁屏自动切歌）时后台启动前台服务受限，可能抛
            // ForegroundServiceStartNotAllowedException：会话指令失效属可降级场景，
            // 捕获后 reject，不让异常穿透 Capacitor 桥（pre6）
            call.reject("前台服务启动失败（应用可能在后台）：" + e.getMessage());
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void stopSession(PluginCall call) {
        // 直接 stopService：服务在跑即停，没跑为 no-op。不走 startService——
        // 应用退后台时 API 26+ 后台启动服务限制会抛 IllegalStateException
        getContext().stopService(new Intent(getContext(), MediaNotificationService.class));
        call.resolve();
    }

    @Override
    public void onCommand(String action, double value) {
        JSObject d = new JSObject();
        d.put("action", action);
        // value 恒带：seek 到 0（回开头）时丢弃 value 会让 JS 侧拿不到位置
        d.put("value", value);
        notifyListeners("mediaCommand", d);
    }
}
