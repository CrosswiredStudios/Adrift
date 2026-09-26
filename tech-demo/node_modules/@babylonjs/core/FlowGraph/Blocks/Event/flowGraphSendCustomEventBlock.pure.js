/** This file must only contain pure code and pure imports */
import { getRichTypeByFlowGraphType } from "../../flowGraphRichTypes.pure.js";
import { FlowGraphExecutionBlockWithOutSignal } from "../../flowGraphExecutionBlockWithOutSignal.js";
import { RegisterClass } from "../../../Misc/typeStore.js";
import { defaultValueSerializationFunction } from "../../serialization.js";
/**
 * A block that sends a custom event.
 * To receive this event you need to use the ReceiveCustomEvent block.
 * This block has no output, but does have inputs based on the eventData from the configuration.
 * @see FlowGraphReceiveCustomEventBlock
 */
export class FlowGraphSendCustomEventBlock extends FlowGraphExecutionBlockWithOutSignal {
    constructor(
    /**
     * the configuration of the block
     */
    config) {
        super(config);
        this.config = config;
        for (const key of Object.keys(this.config.eventData ?? {})) {
            const entry = this.config.eventData[key];
            // Handle deserialized config where type may be a string typeName, a plain object
            // with a typeName property (from old JSON serialization), or a proper RichType instance.
            const typeKey = typeof entry.type === "string" ? entry.type : entry.type?.typeName;
            const richType = typeof entry.type?.serialize === "function" ? entry.type : getRichTypeByFlowGraphType(typeKey);
            entry.type = richType;
            this.registerDataInput(key, richType, entry.value);
        }
    }
    _execute(context) {
        const eventId = this.config.eventId;
        // eventData is a map with the key being the data input's name, and value being the data input's value
        const eventData = Object.create(null);
        for (const port of this.dataInputs) {
            Object.defineProperty(eventData, port.name, {
                configurable: true,
                enumerable: true,
                value: port.getValue(context),
                writable: true,
            });
        }
        context.configuration.coordinator.notifyCustomEvent(eventId, eventData);
        this.out._activateSignal(context);
    }
    serialize(serializationObject = {}) {
        super.serialize(serializationObject);
        // Override the eventData in config to store typeName strings instead of RichType instances
        const serializedEventData = Object.create(null);
        for (const key of Object.keys(this.config.eventData ?? {})) {
            const entry = this.config.eventData[key];
            const serializedEntry = { type: entry.type.typeName };
            if (entry.value !== undefined) {
                defaultValueSerializationFunction("value", entry.value, serializedEntry);
            }
            Object.defineProperty(serializedEventData, key, {
                configurable: true,
                enumerable: true,
                value: serializedEntry,
                writable: true,
            });
        }
        serializationObject.config.eventData = serializedEventData;
    }
    /**
     * @returns class name of the block.
     */
    getClassName() {
        return "FlowGraphSendCustomEventBlock" /* FlowGraphBlockNames.SendCustomEvent */;
    }
}
let _Registered = false;
/**
 * Register side effects for flowGraphSendCustomEventBlock.
 * Safe to call multiple times; only the first call has an effect.
 */
export function RegisterFlowGraphSendCustomEventBlock() {
    if (_Registered) {
        return;
    }
    _Registered = true;
    RegisterClass("FlowGraphSendCustomEventBlock" /* FlowGraphBlockNames.SendCustomEvent */, FlowGraphSendCustomEventBlock);
}
//# sourceMappingURL=flowGraphSendCustomEventBlock.pure.js.map