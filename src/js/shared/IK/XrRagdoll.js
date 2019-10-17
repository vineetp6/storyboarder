
const {IK}  = require("./core/three-ik");
const XRIKObject = require( "./XrIkObject");
const PoleConstraint = require( "./constraints/PoleConstraint");
const PoleTarget = require( "./objects/PoleTarget");
const CopyRotation = require( "./constraints/CopyRotation");
require("./utils/Object3dExtension");
// Ragdoll is class which is used to set all specific details to ikrig
// Like head upward, contraints to limb, transformControls events etc.
class XRRagdoll extends XRIKObject
{
    constructor()
    {
        super();
        this.objectTargetDiff = new THREE.Vector3();
    }
    
    //#region External Methods
    // Initializes ragdoll set up all neccessary information 
    initObject(object, controlTargets, poleTargets )
    {
        super.initObject(object, controlTargets );
        this.createPoleTargets(poleTargets);
    }

    updateSkeleton(updateCharacterSkeleton)
    {
        this.updateCharacterSkeleton = updateCharacterSkeleton;
    }

    updateCharacterRotation(updateCharacterRotation)
    {
        this.updateCharacterRotation = updateCharacterRotation;
    }

    updateCharacterPos(updateCharPosition)
    {
        this.updateCharPosition = updateCharPosition;
    }

    // Runs cycle which is updating object
    update()
    {
        super.update();
        if(IK.firstRun)
        {
            IK.firstRun = false;
        }
        if(!this.isEnabledIk)
        {
            if(this.hipsControlTarget.mode === "rotate" && this.attached)
            {
                this.updateCharacterRotation(this.originalObject.children[0].name, this.hipsControlTarget.rotation)
            }
            this.ikSwitcher.applyToIk();
            this.resetControlPoints();
            this.moveRagdoll();
            this.setUpControlTargetsInitialPosition();
            this.recalculateHipsDiff();
        }
        else
        {
            //this.resetControlPoints();
            this.limbsFollowRotation();
            this.ikSwitcher.applyChangesToOriginal();
        }
    }

    // Runs after update to apply changes to object after ik solved
    lateUpdate()
    {
        super.lateUpdate();
        if(this.hipsMouseDown)
        {
            let hipsTarget = this.hipsControlTarget;
            let targetPosition = this.resourceManager.getVector3();
            let targetPos = this.resourceManager.getVector3();
            hipsTarget.getWorldPosition(targetPosition);
            hipsTarget.getWorldPosition(targetPos);

            targetPos.sub(this.objectTargetDiff);
            this.clonedObject.position.copy(targetPos);
            this.clonedObject.updateMatrixWorld(true); 
            
            this.hips.parent.worldToLocal(targetPosition);
            this.hips.position.copy(targetPosition);
            this.hips.updateMatrix();
            this.originalObject.position.copy(this.clonedObject.position);

            this.resourceManager.release(targetPosition);
            this.resourceManager.release(targetPos);
        }
    }

    // Reintializes whole body and ik joints when character was changed
    // Changing character height, head size will fire reinitialization
    reinitialize()
    {    
        let chainObjects = this.chainObjectsValues;
        this.clonedObject.scale.copy(this.originalObject.worldScale());
        this.clonedObject.position.copy(this.originalObject.worldPosition());
        this.clonedObject.quaternion.copy(this.originalObject.worldQuaternion());
        this.clonedObject.updateMatrixWorld(true);
        for(let i = 0; i < chainObjects.length; i++)
        {
            let chain = chainObjects[i].chain;
            chain.reinitializeJoints();
        }
        this.resetControlPoints();
        this.calculteBackOffset();
        this.recalculateHipsDiff();
    }

    recalculateHipsDiff()
    {
        let hipsTarget = this.hipsControlTarget;
        let armatureInverseMatrixWorld = this.resourceManager.getMatrix4();
        armatureInverseMatrixWorld.getInverse(this.rigMesh.skeleton.bones[0].parent.matrixWorld);
        
        hipsTarget.applyMatrix(this.rigMesh.skeleton.bones[0].parent.matrixWorld);
        let hipsWP = this.resourceManager.getVector3().copy(hipsTarget.position);
        hipsTarget.applyMatrix(armatureInverseMatrixWorld);

        let originalObjectWp = this.resourceManager.getVector3().copy(this.originalObject.position);
        this.objectTargetDiff.subVectors(hipsWP, originalObjectWp);

        this.resourceManager.release(armatureInverseMatrixWorld);
        this.resourceManager.release(hipsWP);
        this.resourceManager.release(originalObjectWp);
    }

    // Moves ragdoll hips when original object moved
    moveRagdoll()
    {
        this.originalObject.matrixWorld.decompose(  this.clonedObject.position,  this.clonedObject.quaternion,  this.clonedObject.scale );
    }
    //#endregion

    //#region Internal methods
    //#region Pole targets manipulations
    createPoleTargets(poleTargetMeshes)
    {
        let polePositions = {
            "LeftHand": new THREE.Vector3(0.3, 0.7, -0.5),
            "RightHand": new THREE.Vector3(-0.3, 0.7, -0.5),
            "LeftFoot": new THREE.Vector3(0, 0.4, 0.6),
            "RightFoot": new THREE.Vector3(0, 0.4, 0.6)
        };

        let chainObjects = this.chainObjectsValues;
        let backChain = this.chainObjects["Head"].chain;        
        for(let i = 0; i < poleTargetMeshes.length; i++)
        {
            let poleTargetMesh = poleTargetMeshes[i];
            let chainName = interpretatedPoleTargetsName(poleTargetMesh.name);
            let chain = this.chainObjects[chainName].chain;
            let poleTarget = null;
            if(poleTargetMesh.userData.isInitialized)
            {
                poleTarget = new PoleTarget();
                poleTarget.mesh = poleTargetMesh;
            }
            else
            {
                poleTarget = this.initPoleTargets(chain, polePositions[chainName], poleTargetMesh);
            }
            let poleConstraint = new PoleConstraint(chain, poleTarget);
            chain.joints[0].addIkConstraint(poleConstraint);
            chainObjects[i].poleConstraint = poleConstraint;
        }

        let copyRotation = new CopyRotation(backChain, backChain.joints[4]);
        copyRotation.influence = 50;
        backChain.joints[3].addIkConstraint(copyRotation);
    }

    // Initiallizes pole target for pole contraints
    initPoleTargets(chain, offset, poleTargetMesh)
    {
        let poleTarget = new PoleTarget();
        poleTarget.mesh = poleTargetMesh;
        poleTarget.initialOffset = offset.multiplyScalar(poleTargetMesh.userData.scaleAspect);
        this.calculatePoleTargetOffset(poleTarget, chain);
        poleTarget.initialize(poleTarget.poleOffset);
        
        return poleTarget;
    }

    // Calculates offset of pole target position
    // take in consideration current hips
    // so pole target binded to hips 
    calculatePoleTargetOffset(poleTarget, chain)
    {
        let offset = poleTarget.initialOffset;
        let position = chain.joints[chain.joints.length - 2].bone.worldPosition();
        let hipsOffset = position.clone().sub(this.hips.worldPosition())
        hipsOffset.add(this.hips.position);
        hipsOffset.add(offset);
        poleTarget.poleOffset = hipsOffset;
    }

    changeControlPointsParent(parent)
    {
        let chainObjects = this.chainObjectsValues;
        for(let i = 0; i < chainObjects.length; i++)
        {
            parent.attach(chainObjects[i].controlTarget);
            chainObjects[i].controlTarget.updateMatrixWorld();
        }
    }
    
    //#endregion
    //#region Control points manipulations 
    resetControlPoints()
    {
        let chainObjects = this.chainObjectsValues;
        let boneMatrix = this.resourceManager.getMatrix4();
        this.takeBoneInTheMeshSpace(this.rigMesh, this.hips, boneMatrix);
        this.hipsControlTarget.position.setFromMatrixPosition(boneMatrix);
        for(let i = 0; i < chainObjects.length; i++)
        {
            let chain = chainObjects[i].chain;
            let jointBone = chain.joints[chain.joints.length - 1].bone;
            this.takeBoneInTheMeshSpace(this.rigMesh, jointBone, boneMatrix);
            chainObjects[i].controlTarget.position.setFromMatrixPosition(boneMatrix);
        }
        this.resourceManager.release(boneMatrix);
        this.calculteBackOffset();
    }

    setUpControlTargetsInitialPosition()
    {
        let chainObjects = this.chainObjectsValues;
        for(let i = 0; i < chainObjects.length; i++)
        {
            let joints = chainObjects[i].chain.joints;
            let bone = joints[joints.length-1].bone;
            let target = chainObjects[i].controlTarget;

            let boneQuate = this.resourceManager.getQuaternion();
            let parentInverseQuat = this.resourceManager.getQuaternion();
            let targetWorldInverseQuat = this.resourceManager.getQuaternion();

            bone.getWorldQuaternion(boneQuate);
            this.hips.parent.getWorldQuaternion(parentInverseQuat).inverse();
            target.getWorldQuaternion(targetWorldInverseQuat).inverse()
            target.quaternion.multiply(targetWorldInverseQuat);
            target.quaternion.copy(boneQuate.premultiply(parentInverseQuat));
            
            this.resourceManager.release(parentInverseQuat);
            this.resourceManager.release(boneQuate);
            this.resourceManager.release(targetWorldInverseQuat);
        }
    }
    //#endregion

    updateReact()
    {        
        let ikBones = [];
        for (let bone of this.originalObject.getObjectByProperty("type", "SkinnedMesh").skeleton.bones)
        {
            if(!this.ikSwitcher.ikBonesName.some((boneName) => bone.name === boneName ))
            {
                continue;
            }
            ikBones.push(bone);
        }
        this.updateCharacterSkeleton(ikBones);
    }

    // Sets limbs rotation to control target rotation
    limbsFollowRotation()
    {
        let chainObjects = this.chainObjectsValues;
        for(let i = 0; i < chainObjects.length; i++)
        {
            let joints = chainObjects[i].chain.joints;
            let bone = joints[joints.length -1].bone;

            let target = this.getTargetForSolve();
            let controlTarget = chainObjects[i].controlTarget;
            if((target && controlTarget.uuid !== target.uuid))
            {
              continue;
            }
            this.rotateBoneQuaternion(bone, controlTarget);   
            bone.updateMatrix();
            bone.updateMatrixWorld(true, true);
        }
    }

    // Sets and quaternion angle for bones
    // Give the result of bone always faces direction set by euler
    // Affected by hips rotation
    // Effect like flat foot to earth can be achieved
    rotateBoneQuaternion(bone, boneTarget)
    {
        let targetQuat = this.resourceManager.getQuaternion();
        boneTarget.getWorldQuaternion(targetQuat);
        let quaternion = this.resourceManager.getQuaternion();
        bone.getWorldQuaternion(quaternion).inverse();
        bone.quaternion.multiply(quaternion);
        bone.quaternion.multiply(targetQuat);
        this.resourceManager.release(targetQuat);
        this.resourceManager.release(quaternion);
    }

    //#endregion
    takeBoneInTheMeshSpace(mesh, bone, boneMatrix)
    {
        let armatureInverseMatrixWorld = this.resourceManager.getMatrix4();
        armatureInverseMatrixWorld.getInverse(mesh.skeleton.bones[0].parent.matrixWorld);
        boneMatrix.multiplyMatrices(armatureInverseMatrixWorld, bone.matrixWorld);
        this.resourceManager.release(armatureInverseMatrixWorld);
    }
}

const interpretatedPoleTargetsName = name =>
{
    switch(name)
    {
        case "leftArmPole":
            return "LeftHand";
        case "rightArmPole":
            return "RightHand";
        case "leftLegPole":
            return "LeftFoot";
        case "rightLegPole":
            return "RightFoot";
    }
}

module.exports =  XRRagdoll;
