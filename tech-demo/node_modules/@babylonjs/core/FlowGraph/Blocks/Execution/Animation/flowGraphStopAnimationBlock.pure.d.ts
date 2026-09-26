/** This file must only contain pure code and pure imports */
import { type FlowGraphContext } from "../../../flowGraphContext.js";
import { type FlowGraphDataConnection } from "../../../flowGraphDataConnection.pure.js";
import { type IFlowGraphBlockConfiguration } from "../../../flowGraphBlock.js";
import { type AnimationGroup } from "../../../../Animations/animationGroup.pure.js";
import { FlowGraphAsyncExecutionBlock } from "../../../flowGraphAsyncExecutionBlock.js";
/**
 * Configuration for stopping an animation.
 */
export interface IFlowGraphStopAnimationBlockConfiguration extends IFlowGraphBlockConfiguration {
    /**
     * Whether stopAtFrame uses the unbounded KHR_interactivity timeline.
     * When false, the block retains its legacy positive-frame scheduling behavior.
     */
    useVirtualStopAt?: boolean;
    /**
     * Whether stopping suppresses the animation-group end notification.
     * Defaults to true to preserve the historical StopAnimation behavior.
     */
    skipOnAnimationEnd?: boolean;
}
/**
 * @experimental
 * Block that stops a running animation
 */
export declare class FlowGraphStopAnimationBlock extends FlowGraphAsyncExecutionBlock {
    /**
     * Input connection: The animation to stop.
     */
    readonly animationGroup: FlowGraphDataConnection<AnimationGroup>;
    /**
     * Input connection - if defined (positive integer) the animation will stop at this frame.
     */
    readonly stopAtFrame: FlowGraphDataConnection<number>;
    constructor(config?: IFlowGraphStopAnimationBlockConfiguration);
    _preparePendingTasks(context: FlowGraphContext): void;
    _cancelPendingTasks(context: FlowGraphContext): void;
    _execute(context: FlowGraphContext): void;
    _executeOnTick(context: FlowGraphContext): void;
    /**
     * @returns class name of the block.
     */
    getClassName(): string;
    private _stopAnimation;
}
/**
 * Register side effects for flowGraphStopAnimationBlock.
 * Safe to call multiple times; only the first call has an effect.
 */
export declare function RegisterFlowGraphStopAnimationBlock(): void;
