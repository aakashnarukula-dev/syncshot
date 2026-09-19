package com.app.syncshot

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import com.app.syncshot.data.FirebaseRepo
import com.google.firebase.Firebase
import com.google.firebase.auth.auth
import com.app.syncshot.sync.SyncService
import com.app.syncshot.ui.LoginScreen
import com.app.syncshot.ui.RootScreen
import com.app.syncshot.ui.theme.SsxTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            SsxTheme {
                Surface(Modifier.fillMaxSize()) {
                    val ctx = LocalContext.current
                    // Auth state is read synchronously from the persisted session;
                    // pre-OTP anonymous sessions are discarded.
                    var signedIn by remember { mutableStateOf(FirebaseRepo.purgeAnonymousAndCheck()) }

                    // React to sign-out from anywhere — the Profile "sign out" and
                    // remote per-device revocation (SyncService) both clear auth, and
                    // this routes the UI back to sign-in.
                    DisposableEffect(Unit) {
                        val listener = com.google.firebase.auth.FirebaseAuth.AuthStateListener { fa ->
                            signedIn = fa.currentUser?.isAnonymous == false
                        }
                        Firebase.auth.addAuthStateListener(listener)
                        onDispose { Firebase.auth.removeAuthStateListener(listener) }
                    }

                    // The foreground service also receives remote screenshots, so it
                    // runs while signed in even when media access is declined. Its
                    // MediaStore observer is permission-gated internally; starting it
                    // here must never crash on a denied runtime permission.
                    LaunchedEffect(signedIn) { if (signedIn) SyncService.start(ctx) }

                    if (signedIn) {
                        // Ask for runtime permissions only once the user is in, so
                        // they don't clutter the sign-in (Truecaller consent) screen.
                        RequestPermissions(onMediaPermissionGranted = { granted ->
                            // A service started before the permission result skipped
                            // MediaStore observing. Starting it again lets its
                            // onStartCommand attach the observer now that access is
                            // available; this is a no-op when it was already attached.
                            if (granted) SyncService.start(ctx)
                        })
                        RootScreen(onSignedOut = { signedIn = false })
                    } else {
                        LoginScreen(onSignedIn = { signedIn = true })
                    }
                }
            }
        }
    }
}

@Composable
private fun RequestPermissions(onMediaPermissionGranted: (Boolean) -> Unit) {
    val ctx = LocalContext.current
    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { grants ->
        val mediaPermission = if (Build.VERSION.SDK_INT >= 33) {
            Manifest.permission.READ_MEDIA_IMAGES
        } else {
            Manifest.permission.READ_EXTERNAL_STORAGE
        }
        onMediaPermissionGranted(
            grants[mediaPermission] ?: (
                ContextCompat.checkSelfPermission(ctx, mediaPermission) == PackageManager.PERMISSION_GRANTED
                )
        )
    }
    LaunchedEffect(Unit) {
        val mediaPermission = if (Build.VERSION.SDK_INT >= 33) {
            Manifest.permission.READ_MEDIA_IMAGES
        } else {
            Manifest.permission.READ_EXTERNAL_STORAGE
        }
        val mediaGranted =
            ContextCompat.checkSelfPermission(ctx, mediaPermission) == PackageManager.PERMISSION_GRANTED
        if (mediaGranted) onMediaPermissionGranted(true)
        val perms = buildList {
            if (!mediaGranted) add(mediaPermission)
            if (Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) !=
                    PackageManager.PERMISSION_GRANTED
            ) {
                add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        if (perms.isNotEmpty()) launcher.launch(perms.toTypedArray())
    }
}
