package com.a620.tablet.training

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.window.OnBackInvokedDispatcher

/** App-owned full-screen renderer. The activity and Binder service share :training. */
class TrainingActivity : Activity() {
    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled") // JavaScript executes only the bundled, network-blocked game runtime.
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.statusBarColor = Color.rgb(7, 17, 29)
        window.navigationBarColor = Color.rgb(7, 17, 29)
        window.decorView.systemUiVisibility =
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        if (Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(
                OnBackInvokedDispatcher.PRIORITY_DEFAULT,
            ) { requestTerminate() }
        }

        webView = WebView(this).apply {
            setBackgroundColor(Color.rgb(7, 17, 29))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = false
            settings.databaseEnabled = false
            settings.cacheMode = WebSettings.LOAD_NO_CACHE
            settings.allowContentAccess = false
            settings.allowFileAccess = true
            settings.allowFileAccessFromFileURLs = false
            settings.allowUniversalAccessFromFileURLs = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            settings.setSupportMultipleWindows(false)
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                    request.url.scheme != "file"

                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                    val uri = request.url
                    if (uri.scheme != "file" || uri.path?.startsWith("/android_asset/training/") != true) {
                        return WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", emptyMap(), null)
                    }
                    return super.shouldInterceptRequest(view, request)
                }
            }
            addJavascriptInterface(TrainingJavascriptBridge(this@TrainingActivity, this), "A620Native")
        }
        TrainingUiCoordinator.attachWebView(webView)
        setContentView(webView)
        webView.loadUrl("file:///android_asset/training/index.html")
    }

    @SuppressLint("GestureBackNavigation")
    @Deprecated("Used only on API 30-32; predictive back is registered on API 33+")
    override fun onBackPressed() {
        if (Build.VERSION.SDK_INT < 33) requestTerminate()
    }

    private fun requestTerminate() {
        TrainingJavascriptBridge(this, webView).requestControl("TERMINATE")
    }

    override fun onDestroy() {
        TrainingUiCoordinator.detachWebView(webView)
        webView.removeJavascriptInterface("A620Native")
        webView.stopLoading()
        webView.destroy()
        super.onDestroy()
    }
}
