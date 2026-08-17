plugins {
    id("com.android.application")
}

android {
    namespace = "com.a620.tablet"
    compileSdk = 36
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "com.a620.tablet"
        minSdk = 30
        targetSdk = 36
        versionCode = 7
        versionName = "0.0.7-baseline.7"
    }

    buildFeatures {
        aidl = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    sourceSets {
        getByName("main").java.apply {
            srcDirs(
                "src/main/java",
                "../../kotlin/src/main/kotlin",
                "../../../kotlin/src/main/kotlin",
            )
            exclude(
                "a620/MockController.kt",
                "a620/shell/ControllerHarness.kt",
                "a620/shell/InputGate.kt",
                "a620/shell/MockGame.kt",
                "a620/shell/RuntimeActor.kt",
                "a620/shell/RuntimeChannel.kt",
                "a620/shell/Transport.kt",
            )
        }
    }

    lint {
        abortOnError = true
        warningsAsErrors = true
        checkDependencies = true
    }
}
