import { describe, expect, test } from "bun:test"
import path from "path"
import { Session as SessionNs } from "../../src/session"
import { Bus } from "../../src/bus"
import { Log } from "../../src/util"
import { Instance } from "../../src/project/instance"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { ModelID } from "../../src/provider/schema"
import { AppRuntime } from "../../src/effect/app-runtime"
import { tmpdir } from "../fixture/fixture"

const projectRoot = path.join(__dirname, "../..")
void Log.init({ print: false })

function create(input?: SessionNs.CreateInput) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.create(input)))
}

function get(id: SessionID) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.get(id)))
}

function remove(id: SessionID) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.remove(id)))
}

function messages(sessionID: SessionID) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.messages({ sessionID })))
}

function updateMessage<T extends MessageV2.Info>(msg: T) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.updateMessage(msg)))
}

function updatePart<T extends MessageV2.Part>(part: T) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.updatePart(part)))
}

describe("session.created event", () => {
  test("should emit session.created event when session is created", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        let eventReceived = false
        let receivedInfo: SessionNs.Info | undefined

        const unsub = Bus.subscribe(SessionNs.Event.Created, (event) => {
          eventReceived = true
          receivedInfo = event.properties.info as SessionNs.Info
        })

        const info = await create({})
        await new Promise((resolve) => setTimeout(resolve, 100))
        unsub()

        expect(eventReceived).toBe(true)
        expect(receivedInfo).toBeDefined()
        expect(receivedInfo?.id).toBe(info.id)
        expect(receivedInfo?.projectID).toBe(info.projectID)
        expect(receivedInfo?.directory).toBe(info.directory)
        expect(receivedInfo?.title).toBe(info.title)

        await remove(info.id)
      },
    })
  })

  test("session.created event should be emitted before session.updated", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const events: string[] = []

        const unsubCreated = Bus.subscribe(SessionNs.Event.Created, () => {
          events.push("created")
        })

        const unsubUpdated = Bus.subscribe(SessionNs.Event.Updated, () => {
          events.push("updated")
        })

        const info = await create({})
        await new Promise((resolve) => setTimeout(resolve, 100))
        unsubCreated()
        unsubUpdated()

        expect(events).toContain("created")
        expect(events).toContain("updated")
        expect(events.indexOf("created")).toBeLessThan(events.indexOf("updated"))

        await remove(info.id)
      },
    })
  })
})

describe("step-finish token propagation via Bus event", () => {
  test(
    "non-zero tokens propagate through PartUpdated event",
    async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const info = await create({})

          const messageID = MessageID.ascending()
          await updateMessage({
            id: messageID,
            sessionID: info.id,
            role: "user",
            time: { created: Date.now() },
            agent: "user",
            model: { providerID: "test", modelID: "test" },
            tools: {},
            mode: "",
          } as unknown as MessageV2.Info)

          let received: MessageV2.Part | undefined
          const unsub = Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
            received = event.properties.part
          })

          const tokens = {
            total: 1500,
            input: 500,
            output: 800,
            reasoning: 200,
            cache: { read: 100, write: 50 },
          }

          const partInput = {
            id: PartID.ascending(),
            messageID,
            sessionID: info.id,
            type: "step-finish" as const,
            reason: "stop",
            cost: 0.005,
            tokens,
          }

          await updatePart(partInput)
          await new Promise((resolve) => setTimeout(resolve, 100))

          expect(received).toBeDefined()
          expect(received!.type).toBe("step-finish")
          const finish = received as MessageV2.StepFinishPart
          expect(finish.tokens.input).toBe(500)
          expect(finish.tokens.output).toBe(800)
          expect(finish.tokens.reasoning).toBe(200)
          expect(finish.tokens.total).toBe(1500)
          expect(finish.tokens.cache.read).toBe(100)
          expect(finish.tokens.cache.write).toBe(50)
          expect(finish.cost).toBe(0.005)
          expect(received).not.toBe(partInput)

          unsub()
          await remove(info.id)
        },
      })
    },
    { timeout: 30000 },
  )
})

describe("Session", () => {
  test("remove works without an instance", async () => {
    await using tmp = await tmpdir({ git: true })

    const info = await Instance.provide({
      directory: tmp.path,
      fn: () => create({ title: "remove-without-instance" }),
    })

    await expect(async () => {
      await remove(info.id)
    }).not.toThrow()

    let missing = false
    await get(info.id).catch(() => {
      missing = true
    })

    expect(missing).toBe(true)
  })

  test("updateMessage snapshots the stored message payload", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const info = await create({ title: "message-snapshot" })
        const assistant: MessageV2.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          sessionID: info.id,
          parentID: MessageID.ascending(),
          modelID: "auto" as never,
          providerID: "github-copilot" as never,
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now() },
        }

        await updateMessage(assistant)
        assistant.modelID = "claude-haiku-4.5" as never

        await new Promise((resolve) => setTimeout(resolve, 100))

        const stored = await messages(info.id)
        const found = stored.find((item) => item.info.id === assistant.id)

        expect(found?.info.role).toBe("assistant")
        if (!found || found.info.role !== "assistant") return
        expect(found.info.modelID).toBe(ModelID.make("auto"))

        await remove(info.id)
      },
    })
  })

  test("updateMessage does not let stale auto overwrite a resolved assistant model", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const info = await create({ title: "preserve-resolved-auto-model" })
        const assistantID = MessageID.ascending()
        const base: Omit<MessageV2.Assistant, "modelID"> = {
          id: assistantID,
          role: "assistant",
          sessionID: info.id,
          parentID: MessageID.ascending(),
          providerID: "github-copilot" as never,
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now() },
        }

        await updateMessage({ ...base, modelID: "auto" as never })
        await updateMessage({ ...base, modelID: "claude-haiku-4.5" as never })
        await updateMessage({ ...base, modelID: "auto" as never })

        await new Promise((resolve) => setTimeout(resolve, 100))

        const stored = await messages(info.id)
        const found = stored.find((item) => item.info.id === assistantID)

        expect(found?.info.role).toBe("assistant")
        if (!found || found.info.role !== "assistant") return
        expect(found.info.modelID).toBe(ModelID.make("claude-haiku-4.5"))

        await remove(info.id)
      },
    })
  })
})
