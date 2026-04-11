import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { homoglyphEncode, camelCaseEncode, urlEncode, crEncode, obfuscateSystemMessage, HOMOGLYPH_MAP } from "../proxy/obfuscate"

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

describe("urlEncode", () => {
  it("encodes spaces as +", () => {
    expect(urlEncode("hello world")).toBe("hello+world")
  })

  it("preserves letters and digits", () => {
    expect(urlEncode("abc")).toBe("abc")
    expect(urlEncode("ABC")).toBe("ABC")
    expect(urlEncode("123")).toBe("123")
  })

  it("preserves unreserved special chars * - . _", () => {
    expect(urlEncode("a*b-c.d_e")).toBe("a*b-c.d_e")
  })

  it("encodes punctuation and symbols", () => {
    expect(urlEncode("!@#")).toBe("%21%40%23")
  })

  it("encodes colons, slashes, and equals", () => {
    expect(urlEncode("a=1&b=2")).toBe("a%3D1%26b%3D2")
    expect(urlEncode("http://x")).toBe("http%3A%2F%2Fx")
  })

  it("passes through non-ASCII characters unchanged", () => {
    expect(urlEncode("你好")).toBe("你好")
  })

  it("handles mixed ASCII and non-ASCII", () => {
    expect(urlEncode("hi你好")).toBe("hi你好")
  })

  it("handles empty string", () => {
    expect(urlEncode("")).toBe("")
  })

  it("encodes newlines and tabs", () => {
    expect(urlEncode("\n")).toBe("%0A")
    expect(urlEncode("\t")).toBe("%09")
  })
})

describe("crEncode", () => {
  it("inserts \\r before ASCII symbols", () => {
    expect(crEncode("a!b@c#")).toBe("a\r!b\r@c\r#")
  })

  it("inserts \\r before spaces", () => {
    expect(crEncode("hello world")).toBe("hello\r world")
  })

  it("leaves letters and digits unchanged", () => {
    expect(crEncode("abc123")).toBe("abc123")
  })

  it("inserts \\r before fullwidth space", () => {
    expect(crEncode("a\u3000b")).toBe("a\r\u3000b")
  })

  it("inserts \\r before fullwidth symbols", () => {
    // \uff01 = ！, \uff1a = ：, \uff3b = ［, \uff5b = ｛
    expect(crEncode("a\uff01b\uff1ac\uff3bd\uff5be")).toBe("a\r\uff01b\r\uff1ac\r\uff3bd\r\uff5be")
  })

  it("does not affect fullwidth letters and digits", () => {
    // \uff21 = Ａ, \uff41 = ａ, \uff10 = ０
    expect(crEncode("\uff21\uff41\uff10")).toBe("\uff21\uff41\uff10")
  })

  it("handles empty string", () => {
    expect(crEncode("")).toBe("")
  })

  it("leaves non-ASCII characters unchanged", () => {
    expect(crEncode("你好世界")).toBe("你好世界")
  })

  it("handles all ASCII symbol ranges", () => {
    // \x20-\x2f: space through /
    expect(crEncode(" !/")).toBe("\r \r!\r/")
    // \x3a-\x40: : through @
    expect(crEncode(":@")).toBe("\r:\r@")
    // \x5b-\x60: [ through `
    expect(crEncode("[`")).toBe("\r[\r`")
    // \x7b-\x7e: { through ~
    expect(crEncode("{~")).toBe("\r{\r~")
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

  it("uses urlencode when set", () => {
    process.env.MERIDIAN_OBFUSCATION = "urlencode"
    const result = obfuscateSystemMessage("hi there")
    expect(result).toBe(urlEncode("hi there"))
  })

  it("uses cr when set", () => {
    process.env.MERIDIAN_OBFUSCATION = "cr"
    const result = obfuscateSystemMessage("hi there")
    expect(result).toBe(crEncode("hi there"))
  })

  it("falls back to camelcase for unknown values", () => {
    process.env.MERIDIAN_OBFUSCATION = "unknown"
    const result = obfuscateSystemMessage("hello world")
    expect(result).toBe("HelloWorld")
  })
})
