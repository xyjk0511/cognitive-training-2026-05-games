package a620

import java.nio.file.Files
import java.nio.file.Path

object Gate0Main {
    private fun expectRejected(block: () -> Unit) {
        var rejected = false
        try { block() } catch (_: IllegalStateException) { rejected = true } catch (_: IllegalArgumentException) { rejected = true }
        check(rejected)
    }

    @JvmStatic
    fun main(args: Array<String>) {
        val vectorsPath = Path.of(args.firstOrNull() ?: "../contracts/test-vectors/canonical_json_vectors.json")
        val text = Files.readString(vectorsPath)
        check(text.contains("object-order"))

        val values = listOf(
            mapOf("z" to 0L, "a" to 1L, "nested" to mapOf("b" to 2L, "a" to 1L)),
            mapOf("line" to "a\nb", "quote" to "\"", "slash" to "/", "unicode" to "捕光行动", "emoji" to "🍎"),
            mapOf("min" to -9_007_199_254_740_991L, "max" to 9_007_199_254_740_991L, "zero" to 0L),
            mapOf("😀" to 1L, "\ue000" to 2L, "a" to 3L),
            listOf(3L, mapOf("b" to 2L, "a" to 1L), null, true, false, "x"),
        )
        val expected = listOf(
            "{\"a\":1,\"nested\":{\"a\":1,\"b\":2},\"z\":0}",
            "{\"emoji\":\"🍎\",\"line\":\"a\\nb\",\"quote\":\"\\\"\",\"slash\":\"/\",\"unicode\":\"捕光行动\"}",
            "{\"max\":9007199254740991,\"min\":-9007199254740991,\"zero\":0}",
            "{\"a\":3,\"😀\":1,\"\":2}",
            "[3,{\"a\":1,\"b\":2},null,true,false,\"x\"]",
        )
        values.zip(expected).forEachIndexed { index, (value, expectedString) ->
            check(CanonicalJson.canonicalString(value) == expectedString) {
                "canonical vector $index mismatch: ${CanonicalJson.canonicalString(value)}"
            }
        }
        expectRejected { CanonicalJson.canonicalString(mapOf("bad" to "\uD800")) }

        val controller = MockController()
        controller.apply(RuntimeInput.PREPARE)
        controller.apply(RuntimeInput.READY)
        controller.apply(RuntimeInput.START)
        controller.apply(RuntimeInput.COMMAND_ACCEPTED)
        controller.apply(RuntimeInput.EFFECTIVE_START_REACHED)
        controller.apply(RuntimeInput.STARTED)
        check(controller.state == RuntimeState.RUNNING)
        controller.apply(RuntimeInput.BATCH_CLOSED)
        controller.apply(RuntimeInput.ACTIVE_TIME_REACHED_DURATION)
        controller.apply(RuntimeInput.DEADLINE)
        controller.apply(RuntimeInput.RESULT_READY)
        controller.apply(RuntimeInput.ACK_RESULT_COMMITTED)
        check(controller.state == RuntimeState.RESULT_COMMITTED)

        expectRejected { RuntimeStateMachine.reduce(RuntimeState.RUNNING, RuntimeInput.RESULT_READY) }
        expectRejected { RuntimeStateMachine.reduce(RuntimeState.UNPREPARED, RuntimeInput.QUERY_STATE) }
        expectRejected { RuntimeStateMachine.reduce(RuntimeState.UNPREPARED, RuntimeInput.BATCH_CLOSED) }
        expectRejected { RuntimeStateMachine.reduce(RuntimeState.READY, RuntimeInput.COMMAND_ACCEPTED) }
        check(RuntimeStateMachine.reduce(RuntimeState.RUNNING, RuntimeInput.COMMAND_REJECTED) == RuntimeState.ERROR)

        val ledger = BatchEvidenceLedger(8)
        ledger.record(BatchEvidence(1, "a".repeat(64), 37500, "evt-1", 1, 100))
        ledger.reconcile(mapOf(1 to "a".repeat(64)))
        println("KOTLIN_GATE0_TESTS_PASS")
    }
}
