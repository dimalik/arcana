ALTER TABLE "RemoteJob" ADD COLUMN "experimentPurpose" TEXT;
ALTER TABLE "RemoteJob" ADD COLUMN "grounding" TEXT;
ALTER TABLE "RemoteJob" ADD COLUMN "claimEligibility" TEXT;
ALTER TABLE "RemoteJob" ADD COLUMN "promotionPolicy" TEXT;
ALTER TABLE "RemoteJob" ADD COLUMN "evidenceClass" TEXT;

ALTER TABLE "ExperimentRun" ADD COLUMN "experimentPurpose" TEXT;
ALTER TABLE "ExperimentRun" ADD COLUMN "grounding" TEXT;
ALTER TABLE "ExperimentRun" ADD COLUMN "claimEligibility" TEXT;
ALTER TABLE "ExperimentRun" ADD COLUMN "promotionPolicy" TEXT;
ALTER TABLE "ExperimentRun" ADD COLUMN "evidenceClass" TEXT;

ALTER TABLE "ExperimentResult" ADD COLUMN "experimentPurpose" TEXT;
ALTER TABLE "ExperimentResult" ADD COLUMN "grounding" TEXT;
ALTER TABLE "ExperimentResult" ADD COLUMN "claimEligibility" TEXT;
ALTER TABLE "ExperimentResult" ADD COLUMN "promotionPolicy" TEXT;
ALTER TABLE "ExperimentResult" ADD COLUMN "evidenceClass" TEXT;
