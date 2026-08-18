import org.gradle.api.tasks.Sync

plugins {
    id("com.android.application")
}

val trainingRuntimeBundle = file("src/main/assets/training/training-runtime.bundle.js")

val verifyAndroidTrainingAssets by tasks.registering {
    inputs.file(trainingRuntimeBundle)
    doLast {
        check(trainingRuntimeBundle.isFile && trainingRuntimeBundle.length() > 10_000L) {
            "training-runtime.bundle.js is missing or stale; run npm run build:android-training"
        }
    }
}

val stageAndroidGameAssets by tasks.registering(Sync::class) {
    from("../../../packages/catch-light/content/config/catch-light-v1.5-w2.json") {
        into("game-config")
        rename { "catch-light.json" }
    }
    from("../../../packages/signal-station/content/config/runtime-config.json") {
        into("game-config")
        rename { "signal-station.json" }
    }
    from("../../../packages/catch-light/content/assets/backgrounds") {
        into("game-assets/backgrounds/catch-light")
    }
    into(layout.buildDirectory.dir("generated/assets/a620Games"))
}

val stageAndroidSharedKotlin by tasks.registering(Sync::class) {
    from("../../kotlin/src/main/kotlin") {
        exclude(
            "a620/shell/ControllerHarness.kt",
            "a620/shell/InputGate.kt",
            "a620/shell/MockGame.kt",
            "a620/shell/RuntimeActor.kt",
            "a620/shell/RuntimeChannel.kt",
            "a620/shell/Transport.kt",
        )
    }
    from("../../../kotlin/src/main/kotlin") {
        exclude("a620/MockController.kt")
    }
    into(layout.buildDirectory.dir("generated/sources/sharedKotlin"))
}

android {
    namespace = "com.a620.tablet"
    compileSdk = 36
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "com.a620.tablet"
        minSdk = 30
        targetSdk = 36
        versionCode = 10
        versionName = "0.1.0-game-integration"
    }

    buildFeatures {
        aidl = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    sourceSets {
        getByName("main") {
            java.directories.add("src/main/java")
            kotlin.directories.add("src/main/java")
            kotlin.directories.add(layout.buildDirectory.dir("generated/sources/sharedKotlin").get().asFile.path)
            assets.directories.add(layout.buildDirectory.dir("generated/assets/a620Games").get().asFile.path)
        }
        getByName("test").java.directories.add("src/test/java")
    }

    lint {
        abortOnError = true
        warningsAsErrors = true
        checkDependencies = true
        // compileSdk/targetSdk are intentionally pinned by toolchain.lock.json.
        disable.addAll(setOf("GradleDependency", "OldTargetApi"))
    }
}

tasks.named("preBuild").configure {
    dependsOn(stageAndroidSharedKotlin, stageAndroidGameAssets, verifyAndroidTrainingAssets)
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}
