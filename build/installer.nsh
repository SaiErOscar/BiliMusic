; BiliMusic 安装器自定义脚本（v1.3.6-beta 重写）
;
; v1.3.4 版的 taskkill 方案只处理了僵尸进程，但升级安装仍报「无法关闭 BiliMusic」。
; 插桩定位后确认本版本报错有两个独立成因，本脚本解决其一（另一处见 package.json）：
;
; 【成因 A：包内容超长路径，已由 package.json 修复】
;   @capacitor/android 的 Android 构建中间产物（cap sync 就地生成）被整包打入
;   app.asar.unpacked，深层 Gradle 目录完整路径近 270 字符，超 Windows 目录上限；
;   7z 解包后 extractUsing7za 的 CopyFiles 递归复制在此中止，同子树 394 个文件连带
;   丢失，IfErrors 重试 5 次后弹「无法关闭 BiliMusic」。修复见 build.files /
;   build.asarUnpack 对 node_modules/@capacitor/** 的负向排除。
;
; 【成因 B：旧卸载器跨卷改名缺陷，由本脚本规避】
;   electron-builder 的 uninstallOldVersion 会静默运行旧版卸载器，其 atomicRMDir 把
;   安装目录文件 Rename 到 $PLUGINSDIR（位于 TEMP）；当 TEMP 与安装目录不在同一磁盘卷时
;   （本机 TEMP=I:\tmp、安装目录在 D:）跨卷 MoveFile 必然失败，卸载器 Abort 退出码 2，
;   同样表现为升级失败。此缺陷不是 1.3.6-beta 报错的主因，但会加重失败并在后续版本间复发，
;   故一并处理：安装时清掉旧卸载键跳过该路径，本版卸载器改用 RMDir /r 直删不再改名。
;
; 修复策略：
; 1. customInit（安装器 onInit，运行于 initMultiUser 之后，目录预填不受影响）：
;    a. 检测到 BiliMusic.exe 运行时先弹窗告知再关闭（替代 v1.3.4 的无提示强杀）；
;    b. 清掉旧版卸载注册表键，使 uninstallOldVersion 找不到 UninstallString
;       而直接跳过成因 B 的旧卸载器路径，升级退化为「覆盖安装 + 重写注册表」，
;       不再依赖旧卸载器（本机 1.3.5 及更早的卸载器都有跨卷缺陷）。
; 2. customCheckAppRunning：用 tasklist + taskkill 的简单循环替代内置的
;    PowerShell/CIM 进程检测（免疫执行策略与安全软件干扰）。
; 3. customRemoveFiles：本版卸载器删除文件改用 RMDir /r 直删，
;    不再走跨卷 Rename 的 atomicRMDir，未来版本间的升级不会再触发本缺陷。

!macro customCheckAppRunning
  ; 简单可靠的进程检测：tasklist 精确匹配映像名，findstr 行首锚定
  StrCpy $R1 0
  check_loop:
    IntOp $R1 $R1 + 1
    nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH 2>NUL | "$SYSDIR\findstr.exe" /B /I /C:"${APP_EXECUTABLE_FILENAME}"`
    Pop $R0
    ${If} $R0 != 0
      Goto check_done
    ${EndIf}
    ${If} $R1 > 3
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY restart_check
      Quit
      restart_check:
      StrCpy $R1 0
      Goto check_loop
    ${EndIf}
    ; 发现进程：通知用户并强制结束（含子进程树）
    ${If} $R1 == 1
    ${AndIfNot} ${Silent}
      MessageBox MB_OK|MB_ICONINFORMATION "$(appRunning)" /SD IDOK
    ${EndIf}
    nsExec::Exec `taskkill /IM "${APP_EXECUTABLE_FILENAME}" /T /F`
    Pop $R0
    Sleep 800
    Goto check_loop
  check_done:
!macroend

!macro customInit
  ; ---- 1. 关闭运行中的应用（有提示，替代旧版无提示强杀）----
  nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH 2>NUL | "$SYSDIR\findstr.exe" /B /I /C:"${APP_EXECUTABLE_FILENAME}"`
  Pop $R0
  ${If} $R0 == 0
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONINFORMATION "检测到 BiliMusic 正在运行。$\r$\n安装程序将关闭它后继续，请先保存正在进行的操作。" /SD IDOK
    ${EndIf}
    nsExec::Exec `taskkill /IM "${APP_EXECUTABLE_FILENAME}" /T /F`
    Pop $R0
    Sleep 800
  ${EndIf}

  ; ---- 2. 清除旧版卸载注册表键，跳过有跨卷缺陷的旧卸载器 ----
  ; initMultiUser 已在此之前读取 InstallLocation 完成目录预填，此处删键无副作用。
  ; 覆盖安装由 7z 解包直接覆盖旧文件，安装完成后重写全新注册表键。
  DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"
  DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"
  DeleteRegKey HKLM "${INSTALL_REGISTRY_KEY}"
  DeleteRegKey HKLM "${UNINSTALL_REGISTRY_KEY}"
!macroend

!macro customRemoveFiles
  ; 卸载器删除文件：直接 RMDir /r（跨卷安全），
  ; 替代内置 atomicRMDir 的跨卷 Rename（TEMP 与安装目录不同卷时必然失败）。
  ; 先把进程工作目录移出安装目录，避免目录被自身占用。
  SetOutPath $TEMP
  RMDir /r $INSTDIR
!macroend
