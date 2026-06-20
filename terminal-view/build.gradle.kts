// Vendored from Termux's terminal-view (Apache License 2.0). Unmodified — it renders a
// com.termux.terminal.TerminalSession, which here is backed by a WebSocket.
// See THIRD_PARTY_LICENSE.md.
plugins {
    id("com.android.library")
}

android {
    namespace = "com.termux.view"
    compileSdk = 34

    defaultConfig {
        minSdk = 24
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
}

dependencies {
    implementation("androidx.annotation:annotation:1.8.0")
    api(project(":terminal-emulator"))
}
