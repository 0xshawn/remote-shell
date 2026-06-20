package com.remoteshell.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp

@Composable
fun LoginScreen(
    initialServer: String,
    initialUser: String,
    initialPassword: String,
    initialSave: Boolean,
    loggingIn: Boolean,
    error: String?,
    onLogin: (server: String, user: String, pass: String, save: Boolean) -> Unit,
) {
    var server by rememberSaveable { mutableStateOf(initialServer) }
    var user by rememberSaveable { mutableStateOf(initialUser.ifEmpty { "admin" }) }
    var pass by rememberSaveable { mutableStateOf(initialPassword) }
    var save by rememberSaveable { mutableStateOf(initialSave) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Remote Shell", style = MaterialTheme.typography.headlineMedium)

        OutlinedTextField(
            value = server,
            onValueChange = { server = it },
            label = { Text("Server URL") },
            placeholder = { Text("https://shell.example.com:8443") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = user,
            onValueChange = { user = it },
            label = { Text("Username") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = pass,
            onValueChange = { pass = it },
            label = { Text("Password") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth(),
        )

        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .clickable { save = !save },
        ) {
            Text("Remember credentials", modifier = Modifier.weight(1f))
            Switch(checked = save, onCheckedChange = { save = it })
        }

        if (error != null) {
            Text(error, color = MaterialTheme.colorScheme.error)
        }

        Button(
            onClick = { onLogin(server.trim(), user.trim(), pass, save) },
            enabled = !loggingIn && server.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (loggingIn) {
                CircularProgressIndicator(modifier = Modifier.size(20.dp))
            } else {
                Text("Sign in")
            }
        }
    }
}
