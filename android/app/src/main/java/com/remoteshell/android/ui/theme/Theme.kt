package com.remoteshell.android.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val DarkColors = darkColorScheme(
    primary = Color(0xFF4FC3F7),
    background = Color(0xFF1E1E1E),
    surface = Color(0xFF252526),
    onBackground = Color(0xFFD4D4D4),
    onSurface = Color(0xFFD4D4D4),
)

private val LightColors = lightColorScheme(
    primary = Color(0xFF0277BD),
    background = Color(0xFFFAFAFA),
    surface = Color(0xFFFFFFFF),
)

@Composable
fun RemoteShellTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        content = content,
    )
}
