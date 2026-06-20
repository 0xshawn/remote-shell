// Vendored from Termux's terminal-emulator (Apache License 2.0), with the local-pty /
// JNI backend removed — sessions are driven by a remote byte stream instead.
// See THIRD_PARTY_LICENSE.md.
plugins {
    id("com.android.library")
}

android {
    namespace = "com.termux.terminal"
    compileSdk = 34

    defaultConfig {
        minSdk = 24
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation("androidx.annotation:annotation:1.8.0")
}
