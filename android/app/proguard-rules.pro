# Keep the vendored Termux terminal classes (reflection-free, but referenced by the view).
-keep class com.termux.terminal.** { *; }
-keep class com.termux.view.** { *; }

# OkHttp ships with its own consumer rules; nothing extra needed here.
