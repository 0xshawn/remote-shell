package com.remoteshell.android.net

import okhttp3.OkHttpClient
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/**
 * Builds the OkHttp clients used for the login API and the /ws socket.
 *
 * The client always trusts ANY TLS certificate and accepts any hostname (the equivalent of
 * `curl -k`), because remote-shell servers typically use a self-signed certificate (often
 * CN=localhost, reached by IP). This disables protection against man-in-the-middle attacks;
 * it is intentional for this personal-server tool.
 */
object HttpClients {

    fun build(forWebSocket: Boolean): OkHttpClient {
        val b = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS)
        if (forWebSocket) {
            b.pingInterval(30, TimeUnit.SECONDS) // mirrors the server's 30s heartbeat
            b.readTimeout(0, TimeUnit.MILLISECONDS) // a websocket has no read timeout
        } else {
            b.readTimeout(15, TimeUnit.SECONDS)
        }
        applyInsecure(b)
        return b.build()
    }

    private fun applyInsecure(b: OkHttpClient.Builder) {
        val trustAll = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        }
        val ctx = SSLContext.getInstance("TLS").apply {
            init(null, arrayOf<TrustManager>(trustAll), SecureRandom())
        }
        b.sslSocketFactory(ctx.socketFactory, trustAll)
        b.hostnameVerifier { _, _ -> true }
    }
}
