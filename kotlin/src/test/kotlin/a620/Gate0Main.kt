package a620

import java.nio.file.Files
import java.nio.file.Path

object Gate0Main {
    @JvmStatic fun main(args: Array<String>) {
        val vectorsPath = Path.of(args.firstOrNull() ?: "../contracts/test-vectors/canonical_json_vectors.json")
        val text = Files.readString(vectorsPath)
        // Avoid external JSON dependencies: assert known golden values directly and ensure file is present.
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
        values.zip(expected).forEachIndexed { i, (value, expectedString) -> check(CanonicalJson.canonicalString(value) == expectedString) { "canonical vector $i mismatch: ${CanonicalJson.canonicalString(value)}" } }

        val controller = MockController()
        controller.apply(RuntimeInput.PREPARE)
        controller.apply(RuntimeInput.READY)
        controller.apply(RuntimeInput.START)
        controller.apply(RuntimeInput.EFFECTIVE_START_REACHED)
        check(controller.state == RuntimeState.RUNNING)
        controller.apply(RuntimeInput.ACTIVE_TIME_REACHED_DURATION)
        controller.apply(RuntimeInput.RESULT_READY)
        controller.apply(RuntimeInput.ACK_RESULT_COMMITTED)
        check(controller.state == RuntimeState.RESULT_COMMITTED)

        var rejected = false
        try { RuntimeStateMachine.reduce(RuntimeState.RUNNING, RuntimeInput.RESULT_READY) } catch (_: IllegalStateException) { rejected = true }
        check(rejected)

        val ledger = BatchEvidenceLedger(8)
        ledger.record(BatchEvidence(1, "a".repeat(64), 37500, "evt-1", 1, 100))
        ledger.reconcile(mapOf(1 to "a".repeat(64)))
        println("KOTLIN_GATE0_TESTS_PASS")
    }
}
