plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.ksp)
}

// Apply Firebase's google-services plugin only when the config file is present,
// so assembleDebug stays green without app/google-services.json.
if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}

// Truecaller partner key is pluggable: set it via a gradle property
// (-PTRUECALLER_PARTNER_KEY=..., gradle.properties, or the
// ORG_GRADLE_PROJECT_TRUECALLER_PARTNER_KEY / TRUECALLER_PARTNER_KEY env var).
// It arrives after the partner app for com.app.syncshot is registered; until
// then it stays empty and the Truecaller button greys out (server /init also
// returns an empty partnerKey, which the app treats the same way).
val truecallerPartnerKey: String =
    (project.findProperty("TRUECALLER_PARTNER_KEY") as String?)
        ?: System.getenv("TRUECALLER_PARTNER_KEY")
        ?: ""

android {
    namespace = "com.app.syncshot"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.app.syncshot"
        minSdk = 26
        targetSdk = 34
        versionCode = 2
        versionName = "2.0.0"

        buildConfigField("String", "TRUECALLER_PARTNER_KEY", "\"$truecallerPartnerKey\"")
        manifestPlaceholders["truecallerPartnerKey"] = truecallerPartnerKey
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material3)
    implementation(libs.androidx.material.icons.extended)
    implementation(libs.coil.compose)
    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.haze)
    implementation(libs.haze.materials)

    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.firestore)
    implementation(libs.firebase.storage)
    implementation(libs.firebase.auth)
    implementation(libs.firebase.functions)
    implementation(libs.firebase.messaging)

    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    implementation(libs.androidx.room.paging)
    ksp(libs.androidx.room.compiler)

    implementation(libs.androidx.paging.runtime.ktx)
    implementation(libs.androidx.paging.compose)

    implementation(libs.androidx.camera.core)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    implementation(libs.androidx.concurrent.futures.ktx)
    implementation(libs.guava)
    implementation(libs.mlkit.barcode.scanning)

    implementation(libs.kotlinx.coroutines.play.services)
    implementation(libs.zxing.core)

    debugImplementation(libs.androidx.ui.tooling)
    testImplementation(libs.junit)
}
