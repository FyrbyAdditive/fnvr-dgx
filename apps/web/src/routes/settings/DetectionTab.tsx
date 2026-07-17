import { DetectorCard } from "./DetectorCard";
import { ClassesCard } from "./ClassesCard";

export function DetectionTab({ isAdmin }: { isAdmin: boolean }) {
  return (
    <>
      <DetectorCard isAdmin={isAdmin} />
      <ClassesCard isAdmin={isAdmin} />
    </>
  );
}
