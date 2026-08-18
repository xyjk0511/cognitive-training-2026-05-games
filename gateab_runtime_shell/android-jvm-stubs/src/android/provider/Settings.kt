package android.provider

import android.content.ContentResolver

object Settings {
    object Global {
        const val BOOT_COUNT: String = "boot_count"
        @Volatile private var bootCountForTest: Int = 1
        fun getInt(resolver: ContentResolver, name: String, defaultValue: Int): Int =
            if (name == BOOT_COUNT) bootCountForTest else defaultValue
        fun setBootCountForTest(value: Int) { bootCountForTest = value }
    }
}
