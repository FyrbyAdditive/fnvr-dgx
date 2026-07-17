import { useState } from "react";
import { Person } from "@/lib/api";
import { useMe } from "@/lib/me";
import { ReviewCard } from "./ReviewCard";
import { PeopleCard } from "./PeopleCard";
import { PersonDetailDialog } from "./PersonDetailDialog";
import { UploadEnrolModal } from "./UploadEnrolModal";
import { ClusterRunBanner, ClusterRunButton, DriftPill } from "./Clusters";

// Faces tab: one review queue (recurring strangers + recent
// sightings, with bulk triage) over a People card. Person drill-down
// opens in a dialog so the operator never loses their place.
export function Faces() {
  const { data: me } = useMe();
  const isAdmin = !!me?.is_admin;
  const [detailPerson, setDetailPerson] = useState<Person | null>(null);
  const [showUpload, setShowUpload] = useState(false);

  return (
    <div className="p-4 space-y-4 max-w-6xl">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-lg font-semibold">Faces</h1>
        <DriftPill />
        <div className="ml-auto flex items-center gap-2">
          <ClusterRunButton isAdmin={isAdmin} />
        </div>
      </div>
      <ClusterRunBanner />

      <ReviewCard isAdmin={isAdmin} />

      <PeopleCard
        isAdmin={isAdmin}
        onOpen={setDetailPerson}
        onUpload={() => setShowUpload(true)}
      />

      {detailPerson && (
        <PersonDetailDialog
          person={detailPerson}
          isAdmin={isAdmin}
          onClose={() => setDetailPerson(null)}
        />
      )}
      {showUpload && (
        <UploadEnrolModal
          onClose={() => setShowUpload(false)}
          onEnrolled={() => setShowUpload(false)}
        />
      )}
    </div>
  );
}
