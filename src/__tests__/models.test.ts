/**
 * Unit tests for model resolution and utility functions.
 */
import { describe, it, expect } from "bun:test"
import { resolveModel, isClosedControllerError, stripExtendedContext, hasExtendedContext } from "../proxy/models"

describe("resolveModel", () => {
  it("passes through base aliases unchanged", () => {
    expect(resolveModel("claude-sonnet-4-6")).toBe("claude-sonnet-4-6")
    expect(resolveModel("sonnet")).toBe("sonnet")
    expect(resolveModel("haiku")).toBe("haiku")
    expect(resolveModel("opus")).toBe("opus")
  })

  it("appends [1m] for opus-4-6 and opus-4-7", () => {
    expect(resolveModel("claude-opus-4-6")).toBe("claude-opus-4-6[1m]")
    expect(resolveModel("claude-opus-4-7")).toBe("claude-opus-4-7[1m]")
  })

  it("never appends [1m] to non-opus-4-6/4-7 models", () => {
    expect(resolveModel("sonnet")).toBe("sonnet")
    expect(resolveModel("claude-sonnet-4-6")).toBe("claude-sonnet-4-6")
    expect(resolveModel("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5-20250929")
    expect(resolveModel("haiku")).toBe("haiku")
  })
})

describe("stripExtendedContext", () => {
  it("strips [1m] suffix from any model", () => {
    expect(stripExtendedContext("opus[1m]")).toBe("opus")
    expect(stripExtendedContext("sonnet[1m]")).toBe("sonnet")
    expect(stripExtendedContext("claude-sonnet-4-6[1m]")).toBe("claude-sonnet-4-6")
  })

  it("returns model unchanged when no [1m] suffix", () => {
    expect(stripExtendedContext("opus")).toBe("opus")
    expect(stripExtendedContext("sonnet")).toBe("sonnet")
    expect(stripExtendedContext("haiku")).toBe("haiku")
  })
})

describe("hasExtendedContext", () => {
  it("returns true for [1m] models", () => {
    expect(hasExtendedContext("opus[1m]")).toBe(true)
    expect(hasExtendedContext("sonnet[1m]")).toBe(true)
    expect(hasExtendedContext("claude-opus-4-6[1m]")).toBe(true)
  })

  it("returns false for base models", () => {
    expect(hasExtendedContext("opus")).toBe(false)
    expect(hasExtendedContext("sonnet")).toBe(false)
    expect(hasExtendedContext("haiku")).toBe(false)
  })
})

describe("isClosedControllerError", () => {
  it("returns true for Controller is already closed error", () => {
    expect(isClosedControllerError(new Error("Controller is already closed"))).toBe(true)
  })

  it("returns true when message contains the phrase", () => {
    expect(isClosedControllerError(new Error("Error: Controller is already closed foo"))).toBe(true)
  })

  it("returns false for other errors", () => {
    expect(isClosedControllerError(new Error("something else"))).toBe(false)
  })

  it("returns false for non-Error values", () => {
    expect(isClosedControllerError("string")).toBe(false)
    expect(isClosedControllerError(null)).toBe(false)
    expect(isClosedControllerError(undefined)).toBe(false)
    expect(isClosedControllerError(42)).toBe(false)
  })
})
