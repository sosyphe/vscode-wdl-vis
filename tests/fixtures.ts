// Shared WDL fixture and offset helpers.
//
// SAMPLE is deliberately adversarial: an imported dotted call with an alias, a
// scatter wrapping an if, a bare `call` with no body, a heredoc command holding
// both `}` and an apostrophe, and a brace command holding an awk `'{print}'`.

import type { OffsetRange } from '../src/language/outline'

export const SAMPLE = `version 1.1

import "lib.wdl" as lib

struct Config {
  String name
  Int? retries
}

workflow pipeline {
  input {
    Array[File] reads
    Int depth = 30
  }

  scatter (sample in reads) {
    call lib.align as aligned {
      input:
        reads = sample,
        depth = depth
    }

    if (depth > 20) {
      call qc {
        input:
          bam = aligned.bam
      }
    }
  }

  call report

  output {
    Array[File] bams = aligned.bam
  }
}

task align {
  input {
    File reads
  }

  command <<<
    awk '{print $1}' ~{reads}
    if [ -s out.txt ]; then
      echo "}"
    fi
  >>>

  output {
    File bam = "out.bam"
  }

  runtime {
    docker: "ubuntu:22.04"
  }
}

task report {
  command {
    echo "done" | awk '{print}'
  }
  runtime {
    docker: "ubuntu:22.04"
  }
}
`

/** The text a range covers — the assertion that actually matters for offsets. */
export function slice(text: string, range: OffsetRange): string {
  return text.slice(range.start, range.end)
}

/** Zero-based line containing `offset`. */
export function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length - 1
}

/** Every line's index, for readable assertions about folding. */
export function lines(text: string): string[] {
  return text.split('\n')
}
