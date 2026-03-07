; installer.nsh — 安装前自动结束旧版进程树
; 在 NSIS .onInit 阶段执行，早于任何文件写入

!macro customInit
  ; 先尝试优雅关闭主进程（发送 WM_CLOSE）
  FindWindow $0 "" "OpenClaw 部署工具"
  IntCmp $0 0 +2
    SendMessage $0 ${WM_CLOSE} 0 0

  ; 等待 2 秒让进程自行退出
  Sleep 2000

  ; 强制结束整个进程树（主进程 + GPU/renderer/utility 子进程）
  nsExec::ExecToLog 'taskkill /F /IM "OpenClaw-Installer.exe" /T'
  ; 额外等待文件句柄释放
  Sleep 1000
!macroend
