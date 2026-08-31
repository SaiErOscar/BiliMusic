; BiliMusic 安装器自定义初始化（v1.3.4）
; 问题：应用退出后可能残留挂死进程（不响应 WM_CLOSE），安装器内置的
; "请关闭应用"检查对僵尸进程无效，导致升级安装必须先手动卸载。
; 解法：.onInit 最前面直接强杀残留的 BiliMusic.exe，再走正常检查流程。

!macro customInit
  ; /IM 按映像名 /T 连同子进程 /F 强制结束；找不到进程时静默继续
  nsExec::Exec 'taskkill /IM BiliMusic.exe /T /F'
  Pop $0 ; 丢弃返回码（0=杀到了，非0=没有运行中的进程，均无需处理）
  Sleep 500 ; 等待句柄释放
!macroend
