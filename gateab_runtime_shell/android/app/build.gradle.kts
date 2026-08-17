plugins {
    id("com.android.application")
}

android {
    namespace = "com.a620.tablet"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.a620.tablet"
        minSdk = 30
        targetSdk = 36
        versionCode = 6
        versionName = "0.0.6-baseline.6"
    }

    buildFeatures {
        aidl = true
    }
}
