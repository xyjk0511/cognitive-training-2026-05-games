@file:Suppress("UNUSED_PARAMETER")
package android.database.sqlite

import android.content.ContentValues
import android.content.Context
import android.database.Cursor

open class SQLiteDatabase {
    companion object { const val CONFLICT_IGNORE: Int = 4 }
    fun setForeignKeyConstraintsEnabled(enabled: Boolean) = Unit
    fun execSQL(sql: String) = Unit
    fun execSQL(sql: String, bindArgs: Array<out Any?>) = Unit
    fun insertWithOnConflict(table: String, nullColumnHack: String?, values: ContentValues, conflictAlgorithm: Int): Long = 1L
    fun rawQuery(sql: String, selectionArgs: Array<String>): Cursor = Cursor()
    fun beginTransaction() = Unit
    fun setTransactionSuccessful() = Unit
    fun endTransaction() = Unit
}

open class SQLiteOpenHelper(
    val context: Context,
    val name: String?,
    val factory: Any?,
    val version: Int,
) {
    open val writableDatabase: SQLiteDatabase = SQLiteDatabase()
    open val readableDatabase: SQLiteDatabase = writableDatabase
    open fun onConfigure(db: SQLiteDatabase) = Unit
    open fun onCreate(db: SQLiteDatabase) = Unit
    open fun onOpen(db: SQLiteDatabase) = Unit
    open fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
    open fun onDowngrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
    open fun close() = Unit
}
