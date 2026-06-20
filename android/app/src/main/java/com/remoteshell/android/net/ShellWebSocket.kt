package com.remoteshell.android.net

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.net.URLEncoder

/**
 * The /ws connection to the remote-shell server, implementing the same 1-byte-prefixed
 * wire protocol as the web client:
 *
 *   client -> server:  '0'<data> = input,    '1'<json> = control {cmd:'resize'|'kill'}
 *   server -> client:  '0'<data> = output,   '1'<json> = event   {event:'session'|'error'|'ended'}
 *
 * Frames are UTF-8 text frames, matching the Node server's `ws.send(string)`.
 * OkHttp delivers callbacks on a background thread; the owner marshals to the main thread.
 */
class ShellWebSocket(
    private val client: OkHttpClient,
) {

    interface Listener {
        fun onOpen()
        fun onOutput(body: String)
        fun onEvent(event: JSONObject)
        /** Connection ended (close or failure). [t] is non-null on failure. */
        fun onClosed(code: Int, reason: String, t: Throwable?)
    }

    private var ws: WebSocket? = null

    fun connect(serverUrl: String, token: String, session: String, cols: Int, rows: Int, listener: Listener) {
        close()
        val request = Request.Builder().url(wsUrl(serverUrl, token, session, cols, rows)).build()
        ws = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = listener.onOpen()

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (text.isEmpty()) return
                val body = text.substring(1)
                when (text[0]) {
                    '0' -> listener.onOutput(body)
                    '1' -> try { listener.onEvent(JSONObject(body)) } catch (_: Exception) { }
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(NORMAL_CLOSURE, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                listener.onClosed(code, reason, null)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                listener.onClosed(response?.code ?: -1, t.message ?: "failure", t)
            }
        })
    }

    /** Send terminal input ('0' frame). */
    fun sendInput(data: String): Boolean = ws?.send("0$data") ?: false

    /** Send a control command ('1' frame), e.g. {cmd:"resize"} or {cmd:"kill"}. */
    fun sendControl(json: JSONObject): Boolean = ws?.send("1$json") ?: false

    fun sendResize(cols: Int, rows: Int) {
        sendControl(JSONObject().put("cmd", "resize").put("cols", cols).put("rows", rows))
    }

    fun sendKill() {
        sendControl(JSONObject().put("cmd", "kill"))
    }

    fun close() {
        ws?.close(NORMAL_CLOSURE, null)
        ws = null
    }

    companion object {
        private const val NORMAL_CLOSURE = 1000

        private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

        /** OkHttp performs the WebSocket upgrade over the http(s) URL itself. */
        fun wsUrl(serverUrl: String, token: String, session: String, cols: Int, rows: Int): String {
            val base = serverUrl.trim().trimEnd('/')
            return "$base/ws?token=${enc(token)}&session=${enc(session)}&cols=$cols&rows=$rows"
        }
    }
}
