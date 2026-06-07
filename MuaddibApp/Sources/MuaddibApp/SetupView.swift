import SwiftUI

struct SetupView: View {
    let checker: InstallChecker

    var body: some View {
        VStack(spacing: 0) {
            if checker.isRunning && checker.items.isEmpty {
                ProgressView("Checking prerequisites…")
                    .frame(maxWidth: .infinity, minHeight: 80)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(checker.items) { item in
                            CheckRow(item: item)
                            if item.id != checker.items.last?.id {
                                Divider().padding(.leading, 38)
                            }
                        }
                    }
                }
                .frame(maxHeight: 360)
            }

            Divider()

            HStack {
                if checker.isRunning {
                    ProgressView()
                        .controlSize(.small)
                        .scaleEffect(0.7)
                }
                Spacer()
                Button("Re-run") {
                    Task { await checker.run() }
                }
                .disabled(checker.isRunning)
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
    }
}

private struct CheckRow: View {
    let item: InstallChecker.CheckItem

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: iconName)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(iconColor)
                .frame(width: 18, alignment: .center)

            VStack(alignment: .leading, spacing: 2) {
                Text(item.label)
                    .font(.system(size: 12, weight: .medium))
                if !item.hint.isEmpty {
                    Text(item.hint)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
    }

    private var iconName: String {
        switch item.status {
        case .ok:      return "checkmark.circle.fill"
        case .warning: return "exclamationmark.triangle.fill"
        case .failed:  return "xmark.circle.fill"
        }
    }

    private var iconColor: Color {
        switch item.status {
        case .ok:      return Color(red: 0.55, green: 0.88, blue: 0.65)
        case .warning: return Color(red: 0.95, green: 0.78, blue: 0.35)
        case .failed:  return Color(red: 0.92, green: 0.52, blue: 0.52)
        }
    }
}
