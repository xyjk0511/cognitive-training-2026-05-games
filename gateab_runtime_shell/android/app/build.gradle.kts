import org.gradle.api.tasks.Sync

plugins {
    id("com.android.application")
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
        versionCode = 9
        versionName = "0.0.9-w1-platform-gateab"
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
    dependsOn(stageAndroidSharedKotlin)
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}
