import SwiftUI
import UniformTypeIdentifiers

enum AgentType: String, CaseIterable {
    case feature, bug, plan, fast

    var label: String {
        switch self {
        case .feature: return "Feature"
        case .bug:     return "Bug"
        case .plan:    return "Plan"
        case .fast:    return "Fast"
        }
    }
}

struct NewAgentComposerView: View {
    var onDone: () -> Void

    @State private var title = ""
    @State private var description = ""
    @State private var selectedType: AgentType = .feature
    @State private var droppedImages: [(data: Data, filename: String, contentType: String)] = []
    @State private var isDropTargeted = false
    @State private var isSubmitting = false
    @State private var errorMessage: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            headerBar
            Divider().overlay(Color(white: 0.22))
            formContent
        }
        .frame(width: 360)
        .background(Color(white: 0.12))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .colorScheme(.dark)
    }

    private var headerBar: some View {
        HStack(spacing: 8) {
            gripHandle
            Text("New Agent")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Color(white: 0.92))
            Spacer()
            Button(action: onDone) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(Color(white: 0.55))
                    .frame(width: 20, height: 20)
                    .background(Color(white: 0.22))
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
            .help("Close")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private var gripHandle: some View {
        let dot = Circle().frame(width: 2, height: 2)
        return VStack(spacing: 2.5) {
            HStack(spacing: 2.5) { dot; dot }
            HStack(spacing: 2.5) { dot; dot }
            HStack(spacing: 2.5) { dot; dot }
        }
        .foregroundStyle(Color(white: 0.45))
    }

    private var formContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker("", selection: $selectedType) {
                ForEach(AgentType.allCases, id: \.self) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            TextField("Title", text: $title)
                .textFieldStyle(.plain)
                .font(.system(size: 13))
                .foregroundStyle(Color(white: 0.92))
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .background(Color(white: 0.18))
                .clipShape(RoundedRectangle(cornerRadius: 6))

            descriptionEditor

            imageDropZone

            if let error = errorMessage {
                Text(error)
                    .font(.system(size: 11))
                    .foregroundStyle(Color(red: 0.92, green: 0.42, blue: 0.42))
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: 8) {
                Spacer()
                Button("Cancel") { onDone() }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(isSubmitting)

                Button(action: submit) {
                    if isSubmitting {
                        HStack(spacing: 4) {
                            ProgressView().controlSize(.small)
                            Text("Creating…")
                        }
                    } else {
                        Text("Create")
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || isSubmitting)
            }
        }
        .padding(14)
    }

    private var descriptionEditor: some View {
        ZStack(alignment: .topLeading) {
            TextEditor(text: $description)
                .font(.system(size: 12))
                .frame(minHeight: 64, maxHeight: 120)
                .scrollContentBackground(.hidden)
                .background(Color(white: 0.18))
                .clipShape(RoundedRectangle(cornerRadius: 6))
            if description.isEmpty {
                Text("Description (optional)")
                    .foregroundStyle(Color(white: 0.4))
                    .font(.system(size: 12))
                    .padding(.horizontal, 6)
                    .padding(.top, 6)
                    .allowsHitTesting(false)
            }
        }
    }

    private var imageDropZone: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 6)
                .strokeBorder(
                    isDropTargeted ? Color.accentColor : Color(white: 0.3),
                    style: StrokeStyle(lineWidth: 1, dash: [4])
                )
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(isDropTargeted ? Color.accentColor.opacity(0.08) : Color.clear)
                )
                .frame(height: droppedImages.isEmpty ? 36 : 44)

            if droppedImages.isEmpty {
                Text("Drop images here")
                    .font(.system(size: 11))
                    .foregroundStyle(Color(white: 0.45))
            } else {
                HStack(spacing: 6) {
                    Image(systemName: "photo.on.rectangle")
                        .foregroundStyle(Color(white: 0.6))
                    Text("\(droppedImages.count) image\(droppedImages.count == 1 ? "" : "s") attached")
                        .font(.system(size: 11))
                        .foregroundStyle(Color(white: 0.6))
                    Button(action: { droppedImages.removeAll() }) {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(Color(white: 0.5))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .onDrop(of: [UTType.image, UTType.fileURL], isTargeted: $isDropTargeted) { providers in
            handleDrop(providers: providers)
            return true
        }
    }

    private func submit() {
        isSubmitting = true
        errorMessage = nil
        Task {
            do {
                let service = try LinearService.make()
                guard let teamId = LinearService.readEnvVar("LINEAR_TEAM_ID") else {
                    throw LinearService.LinearError.missingTeamId
                }

                let allLabels = try await service.fetchLabels(teamId: teamId)
                let wantedNames = Set(["auto", selectedType.rawValue])
                let labelIds = allLabels
                    .filter { wantedNames.contains($0.name.lowercased()) }
                    .map { $0.id }

                var finalDescription = description
                for image in droppedImages {
                    let cdnUrl = try await service.uploadFile(
                        data: image.data,
                        filename: image.filename,
                        contentType: image.contentType
                    )
                    finalDescription += "\n\n![\(image.filename)](\(cdnUrl))"
                }

                _ = try await service.createIssue(
                    title: title.trimmingCharacters(in: .whitespaces),
                    description: finalDescription.isEmpty ? nil : finalDescription,
                    labelIds: labelIds,
                    teamId: teamId
                )
                onDone()
            } catch {
                errorMessage = error.localizedDescription
                isSubmitting = false
            }
        }
    }

    private func handleDrop(providers: [NSItemProvider]) {
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.png.identifier) {
                provider.loadDataRepresentation(forTypeIdentifier: UTType.png.identifier) { data, _ in
                    guard let data else { return }
                    DispatchQueue.main.async {
                        self.droppedImages.append((data: data, filename: "image.png", contentType: "image/png"))
                    }
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.jpeg.identifier) {
                provider.loadDataRepresentation(forTypeIdentifier: UTType.jpeg.identifier) { data, _ in
                    guard let data else { return }
                    DispatchQueue.main.async {
                        self.droppedImages.append((data: data, filename: "image.jpg", contentType: "image/jpeg"))
                    }
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in
                    guard let data else { return }
                    DispatchQueue.main.async {
                        self.droppedImages.append((data: data, filename: "image.png", contentType: "image/png"))
                    }
                }
            }
        }
    }
}
