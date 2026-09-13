@echo off
rem 图书馆快速选座 - 一键调起 Edge(脚本猫) 安装页
rem 若脚本猫未拦截本地文件，请在 Edge 扩展里开启脚本猫的“允许访问文件 URL”，或手动：脚本猫图标-脚本列表-新建-粘贴 .user.js 内容
for %%f in ("%~dp0*.user.js") do start msedge "%%~ff"
exit
