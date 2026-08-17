package android.content

import android.content.pm.ApplicationInfo

open class Context {
    companion object { const val BIND_AUTO_CREATE: Int = 1 }
    open val applicationInfo: ApplicationInfo = ApplicationInfo()
    open fun bindService(intent: Intent, connection: ServiceConnection, flags: Int): Boolean = true
    open fun unbindService(connection: ServiceConnection) = Unit
}

class Intent(val context: Context? = null, val target: Class<*>? = null)
class ComponentName

interface ServiceConnection {
    fun onServiceConnected(name: ComponentName, service: android.os.IBinder)
    fun onServiceDisconnected(name: ComponentName)
    fun onBindingDied(name: ComponentName) = Unit
    fun onNullBinding(name: ComponentName) = Unit
}
