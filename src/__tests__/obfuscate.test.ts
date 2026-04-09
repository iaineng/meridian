import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { homoglyphEncode, camelCaseEncode, obfuscateSystemMessage, HOMOGLYPH_MAP } from "../proxy/obfuscate"

describe("homoglyphEncode", () => {
  it("replaces mapped Latin characters with lookalikes", () => {
    const result = homoglyphEncode("ace")
    expect(result).toBe("\u0430\u0441\u0435")
  })

  it("leaves unmapped characters unchanged", () => {
    const result = homoglyphEncode("123!@#")
    expect(result).toBe("123!@#")
  })

  it("replaces spaces with ideographic space", () => {
    const result = homoglyphEncode("a b")
    expect(result).toContain("\u3000")
  })

  it("handles empty string", () => {
    expect(homoglyphEncode("")).toBe("")
  })
})

describe("camelCaseEncode", () => {
  it("capitalizes and joins words", () => {
    expect(camelCaseEncode("you are a financial advisor")).toBe("YouAre A FinancialAdvisor")
  })

  it("isolates single-letter words with spaces", () => {
    expect(camelCaseEncode("this is a test")).toBe("ThisIs A Test")
  })

  it("handles multiple single-letter words", () => {
    const result = camelCaseEncode("a b c")
    // Each single-letter word should be isolated with spaces
    expect(result).toBe("A B C")
  })

  it("preserves spaces between symbol-symbol boundaries", () => {
    // Two non-word tokens separated by space — space should be preserved
    expect(camelCaseEncode("( )")).toBe("( )")
    expect(camelCaseEncode("1 + 2")).toBe("1 + 2")
  })

  it("removes spaces between word and symbol", () => {
    expect(camelCaseEncode("hello (world)")).toBe("Hello(World)")
  })

  it("handles empty string", () => {
    expect(camelCaseEncode("")).toBe("")
  })

  it("handles already-capitalized text", () => {
    expect(camelCaseEncode("Hello World")).toBe("HelloWorld")
  })

  it("handles single word", () => {
    expect(camelCaseEncode("hello")).toBe("Hello")
  })

  it("handles single letter alone", () => {
    expect(camelCaseEncode("a")).toBe("A")
  })

  it("preserves newlines — each line encoded independently", () => {
    expect(camelCaseEncode("foo bar\nbaz qux")).toBe("FooBar\nBazQux")
  })

  it("preserves \\r\\n line endings", () => {
    expect(camelCaseEncode("hello world\r\ngood bye")).toBe("HelloWorld\r\nGoodBye")
  })

  it("preserves tabs", () => {
    expect(camelCaseEncode("hello world\tgood bye")).toBe("HelloWorld\tGoodBye")
  })

  it("handles multiple newlines in a row", () => {
    expect(camelCaseEncode("hello\n\nworld")).toBe("Hello\n\nWorld")
  })

  it("handles mixed content with punctuation", () => {
    expect(camelCaseEncode("hello, world! this is a test.")).toBe("Hello,World!ThisIs A Test.")
  })
})

describe("obfuscateSystemMessage", () => {
  const originalEnv = process.env.MERIDIAN_OBFUSCATION

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MERIDIAN_OBFUSCATION
    } else {
      process.env.MERIDIAN_OBFUSCATION = originalEnv
    }
  })

  it("defaults to camelcase when env var is unset", () => {
    delete process.env.MERIDIAN_OBFUSCATION
    const result = obfuscateSystemMessage("you are a financial advisor")
    expect(result).toBe("YouAre A FinancialAdvisor")
  })

  it("uses homoglyph when explicitly set", () => {
    process.env.MERIDIAN_OBFUSCATION = "homoglyph"
    const result = obfuscateSystemMessage("ace")
    expect(result).toBe(homoglyphEncode("ace"))
  })

  it("uses camelcase when set", () => {
    process.env.MERIDIAN_OBFUSCATION = "camelcase"
    const result = obfuscateSystemMessage("you are a financial advisor")
    expect(result).toBe("YouAre A FinancialAdvisor")
  })

  it("falls back to camelcase for unknown values", () => {
    process.env.MERIDIAN_OBFUSCATION = "unknown"
    const result = obfuscateSystemMessage("hello world")
    expect(result).toBe("HelloWorld")
  })
})
