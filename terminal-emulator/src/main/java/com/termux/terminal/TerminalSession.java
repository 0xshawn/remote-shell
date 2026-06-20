package com.termux.terminal;

/**
 * A terminal session backed by a remote byte stream (a WebSocket to the remote-shell
 * server) instead of a local subprocess.
 * <p>
 * This is a drop-in replacement for the upstream Termux {@code TerminalSession}, which
 * spawns a local pty via JNI. The remote-shell Android client never runs a local shell;
 * it relays bytes to/from a server. We therefore keep only the parts {@link TerminalView}
 * depends on (emulator management + the {@link TerminalOutput} contract) and route I/O
 * through a {@link SessionOutput} sink:
 * <ul>
 *   <li>bytes typed by the user → {@link #write(byte[], int, int)} → {@link SessionOutput#write}</li>
 *   <li>bytes received from the server → {@link #onRemoteOutput(byte[], int)} → emulator</li>
 *   <li>terminal resized → {@link #updateSize} → {@link SessionOutput#onSizeChanged}</li>
 * </ul>
 * Based on Termux's terminal-emulator (Apache License 2.0); see THIRD_PARTY_LICENSE.md.
 * <p>
 * All emulator mutations must happen on the main (UI) thread. The owner is responsible
 * for posting {@link #onRemoteOutput} from the main thread.
 */
public final class TerminalSession extends TerminalOutput {

    /** Receives data produced by this session (user input) and size changes. */
    public interface SessionOutput {
        /** User input bytes destined for the remote shell. */
        void write(byte[] data, int offset, int count);

        /** The terminal was resized; forward the new size to the remote shell. */
        void onSizeChanged(int columns, int rows);
    }

    TerminalEmulator mEmulator;

    /** Callback which gets notified when the screen, title, etc. changes. */
    TerminalSessionClient mClient;

    /** Buffer used to translate code points into UTF-8 before writing. */
    private final byte[] mUtf8InputBuffer = new byte[5];

    private final Integer mTranscriptRows;
    private final SessionOutput mOutput;

    /** Set by the application for user identification of the session, not by the terminal. */
    public String mSessionName;

    public TerminalSession(Integer transcriptRows, TerminalSessionClient client, SessionOutput output) {
        this.mTranscriptRows = transcriptRows;
        this.mClient = client;
        this.mOutput = output;
    }

    public void updateTerminalSessionClient(TerminalSessionClient client) {
        mClient = client;
        if (mEmulator != null) mEmulator.updateTerminalSessionClient(client);
    }

    /** Reflow or initialize the emulator and forward the new size to the server. */
    public void updateSize(int columns, int rows, int cellWidthPixels, int cellHeightPixels) {
        if (mEmulator == null) {
            initializeEmulator(columns, rows, cellWidthPixels, cellHeightPixels);
        } else {
            mEmulator.resize(columns, rows, cellWidthPixels, cellHeightPixels);
        }
        mOutput.onSizeChanged(columns, rows);
    }

    /** The terminal title as set through escape sequences, or null if none set. */
    public String getTitle() {
        return (mEmulator == null) ? null : mEmulator.getTitle();
    }

    public void initializeEmulator(int columns, int rows, int cellWidthPixels, int cellHeightPixels) {
        mEmulator = new TerminalEmulator(this, columns, rows, cellWidthPixels, cellHeightPixels, mTranscriptRows, mClient);
    }

    /** Feed bytes received from the remote shell into the emulator. Call on the main thread. */
    public void onRemoteOutput(byte[] data, int length) {
        if (mEmulator == null) return;
        mEmulator.append(data, length);
        notifyScreenUpdate();
    }

    /** Write user-input data to the remote shell. */
    @Override
    public void write(byte[] data, int offset, int count) {
        mOutput.write(data, offset, count);
    }

    /** Write the Unicode code point to the remote shell encoded in UTF-8. */
    public void writeCodePoint(boolean prependEscape, int codePoint) {
        if (codePoint > 1114111 || (codePoint >= 0xD800 && codePoint <= 0xDFFF)) {
            // 1114111 is the highest code point, [0xD800,0xDFFF] is the surrogate range.
            throw new IllegalArgumentException("Invalid code point: " + codePoint);
        }

        int bufferPosition = 0;
        if (prependEscape) mUtf8InputBuffer[bufferPosition++] = 27;

        if (codePoint <= /* 7 bits */0b1111111) {
            mUtf8InputBuffer[bufferPosition++] = (byte) codePoint;
        } else if (codePoint <= /* 11 bits */0b11111111111) {
            /* 110xxxxx leading byte with leading 5 bits */
            mUtf8InputBuffer[bufferPosition++] = (byte) (0b11000000 | (codePoint >> 6));
            /* 10xxxxxx continuation byte with following 6 bits */
            mUtf8InputBuffer[bufferPosition++] = (byte) (0b10000000 | (codePoint & 0b111111));
        } else if (codePoint <= /* 16 bits */0b1111111111111111) {
            /* 1110xxxx leading byte with leading 4 bits */
            mUtf8InputBuffer[bufferPosition++] = (byte) (0b11100000 | (codePoint >> 12));
            /* 10xxxxxx continuation byte with following 6 bits */
            mUtf8InputBuffer[bufferPosition++] = (byte) (0b10000000 | ((codePoint >> 6) & 0b111111));
            /* 10xxxxxx continuation byte with following 6 bits */
            mUtf8InputBuffer[bufferPosition++] = (byte) (0b10000000 | (codePoint & 0b111111));
        } else { /* max 21 bits = 0b111111111111111111111 */
            /* 11110xxx leading byte with leading 3 bits */
            mUtf8InputBuffer[bufferPosition++] = (byte) (0b11110000 | (codePoint >> 18));
            /* 10xxxxxx continuation byte with following 6 bits */
            mUtf8InputBuffer[bufferPosition++] = (byte) (0b10000000 | ((codePoint >> 12) & 0b111111));
            /* 10xxxxxx continuation byte with following 6 bits */
            mUtf8InputBuffer[bufferPosition++] = (byte) (0b10000000 | ((codePoint >> 6) & 0b111111));
            /* 10xxxxxx continuation byte with following 6 bits */
            mUtf8InputBuffer[bufferPosition++] = (byte) (0b10000000 | (codePoint & 0b111111));
        }
        write(mUtf8InputBuffer, 0, bufferPosition);
    }

    public TerminalEmulator getEmulator() {
        return mEmulator;
    }

    /** Notify the {@link #mClient} that the screen has changed. */
    protected void notifyScreenUpdate() {
        mClient.onTextChanged(this);
    }

    /** Reset terminal emulator state. */
    public void reset() {
        if (mEmulator != null) mEmulator.reset();
        notifyScreenUpdate();
    }

    @Override
    public void titleChanged(String oldTitle, String newTitle) {
        mClient.onTitleChanged(this);
    }

    @Override
    public void onCopyTextToClipboard(String text) {
        mClient.onCopyTextToClipboard(this, text);
    }

    @Override
    public void onPasteTextFromClipboard() {
        mClient.onPasteTextFromClipboard(this);
    }

    @Override
    public void onBell() {
        mClient.onBell(this);
    }

    @Override
    public void onColorsChanged() {
        mClient.onColorsChanged(this);
    }
}
